/**
 * @action/pi-agent — pi (earendil-works/pi, pi.dev) 编码代理能力
 *
 * 通过 pi CLI 的 print 模式 (`pi --print <prompt>`) 驱动 pi 执行编码任务，
 * 与 codex-agent / zcode-agent / claude-agent 平级，作为网页应用开发员的
 * 可切换「主理人」(AGENT_DRIVER=pi)。
 *
 * 与 codex/zcode 的差异:
 *   - codex 走 `codex exec --json` 的 JSONL 事件流协议；
 *   - zcode 走单次 print 模式，直接采集最终 stdout 文本；
 *   - pi 同为 print 模式，但模型经 ~/.pi/agent/models.json 指向 harness 的
 *     LiteLLM 网关（127.0.0.1:48724），与 harness 共用同一套模型与 key 管理。
 *
 * 安全注意（官方 security.md）：pi 无内置权限系统，工具调用不逐个审批，以启动
 * 用户权限执行——沙箱依赖 app-dev 的目录白名单 + 部署侧容器/专用用户。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface PiAgentRequest {
  /** 编码任务提示词 (含角色人设与工作目录约束) */
  prompt: string;
  /** 工作目录 (pi 在此目录内读写文件) */
  cwd?: string;
  /** 模型 (models.json 里的 id，如 harness-gateway/ksyun-deepseek-v4-flash)；
   *  缺省用 PI_AGENT_MODEL 环境变量，再缺省交由 pi 自身配置的默认模型 */
  model?: string;
  /** 超时毫秒 (默认 10 分钟, 编码任务较慢) */
  timeoutMs?: number;
}

export interface PiAgentResponse {
  /** pi 最终输出的文本 (--print 模式的 stdout) */
  text: string;
  /** 驱动标识 */
  driver: "pi";
}

export const DEFAULT_PI_TIMEOUT_MS = 600_000; // 10 min

/** pi CLI 可执行文件 (npm 全局安装; PI_CLI_PATH 可覆盖) */
function piCliPath(): string {
  return process.env.PI_CLI_PATH ?? "pi";
}

/** spawn cwd 必须是已存在的目录: 文件→所在目录; 不存在→父目录→进程目录 */
function resolveAgentCwd(cwd?: string): string {
  const target = cwd ?? process.cwd();
  try {
    if (existsSync(target) && statSync(target).isFile()) return dirname(target);
    if (existsSync(target) && statSync(target).isDirectory()) return target;
  } catch { /* ignore */ }
  const parent = dirname(target);
  if (existsSync(parent)) return parent;
  return process.cwd();
}

/** 组装 pi print 模式参数（导出供单测；模型优先级: 请求级 > PI_AGENT_MODEL env > pi 默认。
 *  工作目录不经 CLI 参数，由 spawn 的 cwd 选项决定。--no-session: 工人运行是临态，
 *  不写会话文件（2026-10-07 实证 pi 1.0.4 支持该 flag）。 */
export function buildPiArgs(prompt: string, cwd: string, model?: string): string[] {
  void cwd;
  const args = ["--print", "--no-session"];
  const resolvedModel = model ?? process.env.PI_AGENT_MODEL;
  if (resolvedModel) args.push("--model", resolvedModel);
  args.push(prompt);
  return args;
}

export const piAgentService: ServiceDefinition<PiAgentRequest, PiAgentResponse> = {
  id: "@action/pi-agent",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "pi (pi.dev) 编码代理：print 模式驱动 pi 执行编码任务，模型经 models.json 接 harness 网关",
};

/** 消费声明（与 codex/zcode-agent 一样, 任务执行自身不依赖认知层; 模型访问在 CLI 侧） */
export const piAgentRef: CapabilityRef = {
  id: "@action/pi-agent",
  versionRange: "^1.0.0",
};

// ── Provider 实现 ────────────────────────────────────────────────

const piAgentProvider: Provider<PiAgentRequest, PiAgentResponse> = {
  service: piAgentService,
  name: "action-pi-agent",
  state: PluginState.Active,
  async execute(
    request: PiAgentRequest,
    ctx: SeamContext,
  ): Promise<Result<PiAgentResponse>> {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      return { ok: false, error: "pi-agent: request.prompt is required and must be non-empty" };
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_PI_TIMEOUT_MS;
    const cwd = resolveAgentCwd(request.cwd);

    ctx.emit({
      type: "pi-agent.spawn",
      layer: LayerId.Action,
      payload: { cwd, model: request.model ?? process.env.PI_AGENT_MODEL ?? "(pi 默认)" },
      traceId: ctx.traceId,
    });

    const args = buildPiArgs(prompt, cwd, request.model);
    // Windows 上 npm 全局命令是 .cmd 包装, 必须走 shell（与 codex-agent 的 useShell 一致）
    const useShell = process.platform === "win32";

    return new Promise<Result<PiAgentResponse>>((resolve) => {
      const child = spawn(piCliPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        cwd,
        shell: useShell,
      });

      let resolved = false;
      const finish = (result: Result<PiAgentResponse>): void => {
        if (resolved) return;
        resolved = true;
        if (!child.killed) child.kill("SIGTERM");
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, error: `pi-agent: timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });

      child.on("error", (e: Error) => {
        clearTimeout(timer);
        finish({
          ok: false,
          error: `pi-agent: failed to spawn pi: ${e.message} (cwd=${cwd})`,
        });
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-5).join("\n");
          finish({
            ok: false,
            error: `pi-agent: pi exited with code ${code}${tail ? `: ${tail}` : text ? `: ${text.slice(-500)}` : ""}`,
          });
          return;
        }
        if (!text) {
          finish({ ok: false, error: "pi-agent: pi produced no output" });
          return;
        }
        finish(ok({ text, driver: "pi" }));
      });
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: `pi-agent ready (cli: ${piCliPath()})`,
      checkedAt: new Date().toISOString(),
    };
  },
};

export { piAgentProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/pi-agent",
  layer: LayerId.Action,
  description: "行动层：pi (pi.dev) 编码代理 (print 模式, models.json 接 harness 网关)",
  version: "0.1.0",
  provides: [piAgentService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Registered;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [piAgentProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
