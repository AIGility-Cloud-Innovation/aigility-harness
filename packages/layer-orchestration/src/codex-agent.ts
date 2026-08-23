/**
 * @orchestration/codex-agent — 编码代理编排能力（骨架，验证可行性）
 *
 * 通过 `codex exec --json` 子进程协议驱动 Codex CLI，
 * 把「编码代理任务」作为编排层的一等能力暴露给上层。
 *
 * 薄适配原则：不复刻 Codex app-server 的原始 JSON-RPC 帧协议，
 * 只消费 CLI 的 JSONL 事件流 —— 与官方 @openai/codex-sdk 同一路径。
 *
 * 落位：主 Orchestration 层（代理调度归编排），次 Infrastructure 层（进程/协议适配）。
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
import { LayerId, PluginState, ok, err } from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-arch/core";

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
   * 续接历史线程 ID（resume 子命令）。
   * TODO: resume 模式下 stdin 语义不同，骨架阶段暂不实现，
   * 传入则会返回 err 并提示边界。
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
  id: "@orchestration/codex-agent",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "编码代理（Codex CLI 子进程驱动，JSONL 事件流薄适配）",
};

// ── 常量 ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const DEFAULT_APPROVAL_POLICY: CodexApprovalPolicy = "on-failure";
const DEFAULT_SANDBOX_MODE: CodexSandboxMode = "workspace-write";

/** 判断 codex 内置 metadata 回退的提示消息 */
const METADATA_FALLBACK_MARKER = "Defaulting to fallback metadata";

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

/** 构造 codex exec 命令行参数 */
function buildArgs(request: CodexAgentRequest): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    `approval_policy="${request.approvalPolicy ?? DEFAULT_APPROVAL_POLICY}"`,
    "-s",
    request.sandboxMode ?? DEFAULT_SANDBOX_MODE,
  ];
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
      state.errorMessage = event.error as string;
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
    const prompt = request.prompt?.trim();
    if (!prompt) {
      return err("codex-agent: request.prompt is required and must be non-empty");
    }
    if (request.threadId) {
      return err(
        "codex-agent: thread resume not yet implemented in skeleton (resume has different stdin semantics)"
      );
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const bin = codexBin();
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
        layer: LayerId.Orchestration,
        payload: { model: planningModel, plan },
        traceId: ctx.traceId,
      });
    }

    ctx.emit({
      type: "codex-agent.spawn",
      layer: LayerId.Orchestration,
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
      const child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let resolved = false;

      const finish = (result: Result<CodexAgentResponse>): void => {
        if (resolved) return;
        resolved = true;
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        resolve(result);
      };

      // 超时
      const timer = setTimeout(() => {
        finish(err(`codex-agent: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // stdout: JSONL 事件流（手动缓冲 + 换行切分）
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
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
          layer: LayerId.Orchestration,
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
      child.stdin?.write(prompt);
      child.stdin?.end();
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
