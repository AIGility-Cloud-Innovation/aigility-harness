/**
 * @action/codex-agent — 编码代理行动能力（骨架，验证可行性）
 *
 * 通过 `codex exec --json` 子进程协议驱动 Codex CLI，
 * 把「编码代理任务」作为行动层的一等能力暴露给上层（D3 工人：领活 → 执行 → 交产出）。
 *
 * 薄适配原则：不复刻 Codex app-server 的原始 JSON-RPC 帧协议，
 * 只消费 CLI 的 JSONL 事件流 —— 与官方 @openai/codex-sdk 同一路径。
 *
 * 落位：D3 行动执行层（编码工人, spawn CLI 子进程产生真实副作用）。
 *
 * JSONL 事件流契约（每行一个 JSON 对象，已验证）：
 *   {"type":"thread.started","thread_id":"01a02c17-..."}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_2","type":"command_execution",...}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"command_execution",...}}
 *   {"type":"item.completed","item":{"id":...,"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"turn.failed","error":"..."}
 */

import { spawn } from "node:child_process";
import { backupHtmlFiles } from "./sandbox-backup.js";
import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 认知层 LLM 契约镜像 ─────────────────────────────────────────
// 通过 Seam 字符串引用 `@cognitive/llm-inference` 解耦，
// 不直接 import layer-cognitive（遵循 Provider 间禁止直接 import 原则）。
// 结构仅反映 codex-agent 规划阶段所需的子集，与 layer-cognitive 契约保持一致。

interface LlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

interface LlmInferenceRequest {
  model: string;
  messages: LlmChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

interface LlmInferenceResponse {
  /** choices[0].message.content 便捷访问 */
  text: string;
  model: string;
}

// ── 类型定义 ─────────────────────────────────────────────────────

export type CodexApprovalPolicy =
  | "on-failure"
  | "on-request"
  | "never"
  | "untrusted";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

/** 编码代理请求 */
export interface CodexAgentRequest {
  /** 编码任务提示词（必需） */
  prompt: string;
  /** 工作目录（默认使用 codex 进程自身 cwd） */
  cwd?: string;
  /** 覆盖 ~/.codex/config.toml 的 model */
  model?: string;
  /**
   * 命令审批策略。默认 `"on-failure"`（自动通过，仅失败时询问），
   * 确保 JSONL 非交互模式下不会因等待审批输入而挂起。
   */
  approvalPolicy?: CodexApprovalPolicy;
  /**
   * 沙箱模式。默认 `"workspace-write"`（允许在工作区内写文件/执行命令）。
   * 设置为 `"read-only"` 时禁止所有文件变更。
   */
  sandboxMode?: CodexSandboxMode;
  /** 整体超时（毫秒），默认 300_000（5 分钟） */
  timeoutMs?: number;
  /**
   * 决策暂停续跑（2026-10-13 决策状态机）：threadId + 决策结论。
   * 续接历史线程（codex exec resume <threadId>）时不重跑，
   * 决策结论注入续接提示词（worker-team 已按 .agent-decision.json 写回）。
   */
  resumeDecision?: { threadId: string; decision: string; decidedBy?: string };
  /**
   * 续接历史线程（codex exec resume <threadId>）。
   * 续接时 prompt 仍经 stdin 注入：resume 子命令的 PROMPT 位置参数传 `-`
   * 即从 stdin 读取（codex 0.153+ 语义，拆包实测）。
   */
  threadId?: string;
  /**
   * 跳过框架内任务规划步骤（默认 false）。
   * 为 false 时，execute 会先经 `@cognitive/llm-inference` 让认知层
   * litellmProvider 产出一份执行计划，证明推理链路穿过本框架 Seam 层；
   * 为 true 则直接 spawn codex，不经过认知层。
   */
  skipPlanning?: boolean;
  /** 规划阶段使用的模型名（默认 `deepseek-v4-pro`，经 LiteLLM 路由） */
  planningModel?: string;
  /**
   * 静默看门狗阈值（毫秒），默认 480_000（8 分钟）。
   * 子进程连续该时长无任何 stdout 事件 = 判定卡死，主动 SIGTERM 并报错，
   * 避免单条命令挂住烧光整个 timeoutMs 窗口。
   * 传 0 或负数关闭看门狗（仅保留整体超时）。
   */
  silentTimeoutMs?: number;
  /**
   * 净化工人生成环境（默认 true）。
   * spawn codex 时剔除宿主进程继承的 Python 相关环境变量
   * （PYTHONPATH / PYTHONHOME / PYTHONSTARTUP / VIRTUAL_ENV 等），
   * 防止宿主解释器的 site-packages 泄漏进子进程导致依赖冲突
   * （如 Python 3.14 的包被 3.13 运行时加载，C 扩展加载失败）。
   */
  sanitizeEnv?: boolean;
}

/** 单次 agent turn 的用量统计 */
export interface CodexAgentTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/** JSONL 事件中 item 对象的通用形态 */
export interface CodexAgentItem {
  id?: string;
  type: string;
  text?: string;
  /** tool_call 的 name */
  name?: string;
  /** tool_call / command_execution 的 input / command */
  input?: unknown;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  message?: string;
}

/** 编码代理响应 */
export interface CodexAgentResponse {
  /** 本 turn 的线程 ID */
  threadId: string;
  /** agent 最终回复文本（合并所有 agent_message） */
  text: string;
  /** 事件项（agent_message / tool_call / command_execution / error ...） */
  items: CodexAgentItem[];
  /** turn 用量统计 */
  usage?: CodexAgentTurnUsage;
  /** 模型不在 Codex 内置元数据表（走回退，性能可能下降） */
  hadMetadataFallback: boolean;
  /** 框架认知层产出的执行计划（skipPlanning=true 时为 undefined） */
  plan?: string;
}

// ── 服务定义 ─────────────────────────────────────────────────────

export const codexAgentService: ServiceDefinition<
  CodexAgentRequest,
  CodexAgentResponse
> = {
  id: "@action/codex-agent",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "编码代理（Codex CLI 子进程驱动，JSONL 事件流薄适配）",
};

// ── 常量 ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
/**
 * 静默看门狗默认阈值：20 分钟内无任何 stdout 事件 = 判定卡死。
 *
 * 2026-10-25 事故：原 8 分钟在「导出费用明细」这类多文件改造上误杀——工人先大量
 * 读代码/探结构，长时间不产生 stdout，连续两轮被判 stalled（各烧 8-20 分钟窗口）。
 * 编码任务的自然静默远长于问答任务，放宽到 20 分钟；真挂死仍由整体 timeoutMs 兜底。
 */
const DEFAULT_SILENT_TIMEOUT_MS = 1_200_000; // 20 min
const DEFAULT_APPROVAL_POLICY: CodexApprovalPolicy = "on-failure";
const DEFAULT_SANDBOX_MODE: CodexSandboxMode = "workspace-write";

/** 判断 codex 内置 metadata 回退的提示消息 */
const METADATA_FALLBACK_MARKER = "Defaulting to fallback metadata";

/**
 * 宿主机 Python 相关环境变量黑名单。
 * 这些变量会让子进程的 Python 解释器加载宿主的 site-packages，
 * 造成运行时版本与 C 扩展编译版本不匹配（如 3.14 加载 3.13 的 .so）。
 * 工人任务使用目标仓库自身的 python/venv，不应继承宿主解释器配置。
 */
const PYTHON_ENV_DENYLIST = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "VIRTUAL_ENV_PROMPT",
  "PYTHONNOUSERSITE",
] as const;

/**
 * 构造净化的子进程环境：剔除 Python 相关污染变量。
 * 保留其余环境（PATH / HOME / 代理 / 框架自身变量等）。
 */
function sanitizeSpawnEnv(
  base: NodeJS.ProcessEnv,
  enabled: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!enabled) return env;
  const removed: string[] = [];
  for (const key of PYTHON_ENV_DENYLIST) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  // 兜底：清理宿主 venv 注入的 bin 目录（其为 3.14 解释器所在处），
  // 其余路径（含 node、系统 bin）必须原样保留，否则会影响所有子进程命令解析。
  if (env.PATH) {
    env.PATH = env.PATH.split(":")
      .filter((p) => p && !/\.hermes\/installs\/.*\/venv\/bin$/.test(p))
      .join(":");
  }
  return env;
}

// ── 内部工具 ─────────────────────────────────────────────────────

function codexBin(): string {
  return process.env.CODEX_BIN ?? "codex";
}

function isMetadataFallbackError(item: CodexAgentItem): boolean {
  return (
    item.type === "error" &&
    typeof item.message === "string" &&
    item.message.includes(METADATA_FALLBACK_MARKER)
  );
}

/** 构造 codex exec / exec resume 命令行参数 */
function buildArgs(request: CodexAgentRequest): string[] {
  const args: string[] = ["exec"];
  if (request.threadId || request.resumeDecision?.threadId) {
    // resume 子命令选项集是 exec 的子集 (实测 0.153.4): 无 -s/--sandbox、
    // -C/--cd —— 沙箱/审批/工作目录由原会话恢复; 仅 -c/-m/--json 等可用
    args.push("resume", request.resumeDecision?.threadId ?? request.threadId!, "--json");
    if (request.model) {
      args.push("-m", request.model);
    }
    // PROMPT 位置参数: `-` = 从 stdin 读取续接指令
    args.push("--skip-git-repo-check", "-");
    return args;
  }
  args.push(
    "--json",
    "--skip-git-repo-check",
    "-c",
    `approval_policy="${request.approvalPolicy ?? DEFAULT_APPROVAL_POLICY}"`,
    "-s",
    request.sandboxMode ?? DEFAULT_SANDBOX_MODE,
  );
  if (request.cwd) {
    args.push("-C", request.cwd);
  }
  if (request.model) {
    args.push("-m", request.model);
  }
  return args;
}

// ── JSONL 事件流解析 ─────────────────────────────────────────────

interface TurnState {
  threadId: string;
  textParts: string[];
  items: CodexAgentItem[];
  usage?: CodexAgentTurnUsage;
  hadMetadataFallback: boolean;
  failed: boolean;
  errorMessage?: string;
}

function processLine(state: TurnState, line: string): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // 跳过非 JSON 行
  }

  switch (event.type) {
    case "thread.started": {
      state.threadId = event.thread_id as string;
      break;
    }
    case "item.completed": {
      const item = event.item as CodexAgentItem;
      if (item) {
        if (isMetadataFallbackError(item)) {
          state.hadMetadataFallback = true;
        } else {
          state.items.push(item);
          if (item.type === "agent_message" && item.text) {
            state.textParts.push(item.text);
          }
        }
      }
      break;
    }
    case "turn.completed": {
      state.usage = event.usage as CodexAgentTurnUsage;
      break;
    }
    case "turn.failed": {
      state.failed = true;
      // error 可能是字符串或 {message} 形态, 统一提取避免 "[object Object]"
      const e = event.error;
      state.errorMessage =
        typeof e === "string"
          ? e
          : typeof (e as { message?: unknown })?.message === "string"
            ? (e as { message: string }).message
            : JSON.stringify(e);
      break;
    }
    default:
      break;
  }
}

// ── Provider 实现 ────────────────────────────────────────────────

const codexAgentProviderImpl: Provider<
  CodexAgentRequest,
  CodexAgentResponse
> = {
  service: codexAgentService,
  name: "orchestration-codex-agent-stub",
  state: PluginState.Active,

  async execute(
    request: CodexAgentRequest,
    ctx: SeamContext,
  ): Promise<Result<CodexAgentResponse>> {
    // 参数校验
    let prompt = request.prompt?.trim();
    const resume = request.resumeDecision;
    if (resume?.threadId) {
      // 决策续跑：线程 + 决策结论（不重跑）；原 prompt 留痕在决策文件里
      if (resume.decision?.trim()) {
        prompt = [
          `【机器人群决策已拍板（injected_decision）】`,
          `决策人：${resume.decidedBy ?? "用户"}`,
          `决策结论：${resume.decision.trim()}`,
          ``,
          `请按上述结论继续执行本任务（沿用原线程上下文）；结论已拍板，无需再开决策点。`,
        ].join("\n");
      }
    }
    if (!prompt) {
      return err(
        resume?.threadId
          ? "codex-agent: resumeDecision 决策结论为空且无 prompt"
          : "codex-agent: request.prompt is required and must be non-empty",
      );
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 静默看门狗：0/负数关闭；默认 8 分钟无事件即判卡死
    const silentMs = request.silentTimeoutMs ?? DEFAULT_SILENT_TIMEOUT_MS;
    const watchdogEnabled = silentMs > 0;
    const sanitize = request.sanitizeEnv ?? true;
    const bin = codexBin();
    backupHtmlFiles(request.cwd ?? process.cwd(), "codex");
    const args = buildArgs(request);

    // ── 框架内闭环：先经认知层 litellmProvider 规划 ──
    // 证明 codex-agent 的推理链路穿过本框架 Seam 层（而非 codex 私自直连 config.toml）。
    let plan: string | undefined;
    if (!request.skipPlanning) {
      const planningModel = request.planningModel ?? "deepseek-v4-pro";
      const planRes = await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
        { id: "@cognitive/llm-inference", versionRange: "^1.0.0" },
        {
          model: planningModel,
          messages: [
            {
              role: "system",
              content:
                "你是一个编码任务规划器。用一句话（≤80字）概述执行计划，不要写代码。",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 200,
          temperature: 0.2,
        },
      );

      if (!planRes.ok) {
        // 认知层不可用属于依赖未满足（dependsOn 语义）
        return err(
          `codex-agent: planning via @cognitive/llm-inference failed: ${planRes.error}`,
        );
      }

      plan = planRes.value.text?.trim();
      ctx.emit({
        type: "codex-agent.planning",
        layer: LayerId.Action,
        payload: { model: planningModel, plan },
        traceId: ctx.traceId,
      });
    }

    ctx.emit({
      type: "codex-agent.spawn",
      layer: LayerId.Action,
      payload: {
        bin,
        args,
        promptLength: prompt.length,
        timeoutMs,
      },
      traceId: ctx.traceId,
    });

    const state: TurnState = {
      threadId: "",
      textParts: [],
      items: [],
      hadMetadataFallback: false,
      failed: false,
    };

    let stderr = "";

    return new Promise<Result<CodexAgentResponse>>((resolve) => {
      // Windows: codex 是 .cmd/.ps1 包装, Node 禁止无 shell 直接 spawn (.bat/.cmd),
      // 必须走 shell; 此时参数按原样拼接, 含空格的参数需自行加引号。
      const useShell = process.platform === "win32";
      const spawnArgs = useShell ? args.map((a) => (a.includes(" ") ? `"${a}"` : a)) : args;
      const child = spawn(bin, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizeSpawnEnv(process.env, sanitize),
        shell: useShell,
      });

      let resolved = false;

      // ── 静默看门狗（idle watchdog，2026-10-14）──────────────────────
      // 与 dsh-interop/session-relay 同构：只要有任何 stdout 产出就重置计时器，
      // 连续 silentMs 一个字节都没有才判定真卡死。
      // 这样「长任务持续有输出」不会误杀，「单条命令挂死」照样被收割。
      const startedAt = Date.now();
      let lastActivityAt = startedAt;
      let idleTimer: NodeJS.Timeout | undefined;
      const clearIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      const bumpIdle = (): void => {
        lastActivityAt = Date.now();
        clearIdle();
        if (!watchdogEnabled) return;
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          const silentFor = Date.now() - lastActivityAt;
          const sinceStart = ((Date.now() - startedAt) / 1000).toFixed(1);
          finish(
            err(
              `codex-agent: stalled — no stdout activity for ${(silentFor / 1000).toFixed(1)}s ` +
                `(threshold ${(silentMs / 1000).toFixed(0)}s, elapsed ${sinceStart}s); ` +
                `last activity at ${new Date(lastActivityAt).toISOString()}; ` +
                `killed to avoid burning the full ${(timeoutMs / 1000).toFixed(0)}s budget. ` +
                `stderr tail: ${stderr.slice(-300) || "(empty)"}`,
            ),
          );
        }, silentMs);
        idleTimer.unref?.(); // 保险丝不该让进程悬着
      };

      // 超时（整体兜底，保留原有行为）
      const timer = setTimeout(() => {
        finish(err(`codex-agent: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (result: Result<CodexAgentResponse>): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearIdle();
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        resolve(result);
      };

      bumpIdle(); // 起表

      // stdout: JSONL 事件流（手动缓冲 + 换行切分）
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        bumpIdle(); // 喂狗：更新时间戳 + 重置 idle 计时器
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) processLine(state, line);
        }
      });

      // stderr: 纯收集（codex 日志/进度输出）
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        bumpIdle(); // stderr 有产出同样说明进程活着
      });

      // 进程结束
      child.on("close", (exitCode) => {
        clearTimeout(timer);

        // 冲刷缓冲
        if (buffer.trim()) processLine(state, buffer.trim());

        if (state.failed) {
          finish(
            err(`codex-agent: turn failed: ${state.errorMessage ?? "unknown error"}`)
          );
          return;
        }

        if (exitCode !== 0 && exitCode !== null) {
          finish(
            err(
              `codex-agent: process exited with code ${exitCode}${stderr ? ` — stderr: ${stderr.slice(-500)}` : ""}`
            )
          );
          return;
        }

        ctx.emit({
          type: "codex-agent.completed",
          layer: LayerId.Action,
          payload: {
            threadId: state.threadId,
            itemCount: state.items.length,
            textLength: state.textParts.join("").length,
            hadMetadataFallback: state.hadMetadataFallback,
          },
          traceId: ctx.traceId,
        });

        finish(
          ok({
            threadId: state.threadId,
            text: state.textParts.join(""),
            items: state.items,
            usage: state.usage,
            hadMetadataFallback: state.hadMetadataFallback,
            plan,
          })
        );
      });

      // 子进程错误
      child.on("error", (e) => {
        clearTimeout(timer);
        finish(err(`codex-agent: failed to spawn ${bin}: ${e.message}`));
      });

      // 写入 prompt 到 stdin，关闭 stdin 触发 codex 开始执行
      // 注意：子进程可能瞬间退出（参数错误/立即失败），此时管道已关闭，
      // 异步写会抛 EPIPE；必须吞掉 stdin 的 error，否则未捕获事件会崩掉宿主进程。
      child.stdin?.on("error", () => {
        /* EPIPE / ERR_STREAM_DESTROYED：子进程已退出，属正常竞态，忽略 */
      });
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch {
        /* 同步抛出（管道已销毁）同样忽略；真实失败由 close/error 事件呈报 */
      }
    });
  },

  async health(): Promise<HealthStatus> {
    // codex 是外部 CLI，不做启动时的长驻连接；
    // 健康探针只验证二进制可解析。
    // 注意：spawnSync 开销很低（<5ms），适合周期性探针。
    const { spawnSync } = await import("node:child_process");
    const bin = codexBin();
    try {
      const result = spawnSync(bin, ["--version"], {
        timeout: 5000,
        stdio: "pipe",
        shell: process.platform === "win32",
      });
      const healthy = result.status === 0;
      return {
        healthy,
        detail: healthy
          ? `codex binary found: ${result.stdout.toString("utf8").split("\n")[0].trim()}`
          : `codex --version returned exit code ${result.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        healthy: false,
        detail: `codex binary not found in PATH: ${bin}`,
        checkedAt: new Date().toISOString(),
      };
    }
  },
};

/** 供 index.ts 注册到 LayerPlugin */
export const codexAgentProvider: Provider<
  CodexAgentRequest,
  CodexAgentResponse
> = codexAgentProviderImpl;
