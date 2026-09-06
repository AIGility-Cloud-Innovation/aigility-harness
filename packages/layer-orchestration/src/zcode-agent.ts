/**
 * @orchestration/zcode-agent — ZCode CLI 编码代理能力
 *
 * 通过 ZCode CLI 的 headless 模式 (`zcode -p <prompt>`) 驱动 ZCode 执行编码任务，
 * 与 codex-agent 平级，作为网页应用生成器的可切换「主理人」(AGENT_DRIVER=zcode)。
 *
 * 与 codex-agent 的差异:
 *   - codex 走 `codex exec --json` 的 JSONL 事件流协议；
 *   - zcode 走单次 print 模式，直接采集最终 stdout 文本。
 * LLM 访问经由 ~/.zcode/cli/config.json 配置（当前指向 AppBase 网关），
 * ZCode 自身的认证/签名机制与网关 Bearer 鉴权互不干扰。
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
import { backupHtmlFiles } from "./sandbox-backup.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface ZcodeAgentRequest {
  /** 编码任务提示词 (含角色人设与工作目录约束) */
  prompt: string;
  /** 工作目录 (ZCode 在此目录内读写文件) */
  cwd?: string;
  /** 权限模式: build | edit | yolo (默认 build) */
  mode?: "build" | "edit" | "yolo";
  /** 超时毫秒 (默认 10 分钟, 编码任务较慢) */
  timeoutMs?: number;
}

export interface ZcodeAgentResponse {
  /** ZCode 最终输出的文本 */
  text: string;
  /** 驱动标识 */
  driver: "zcode";
}

export const DEFAULT_ZCODE_TIMEOUT_MS = 600_000; // 10 min

/** ZCode CLI 单文件入口 (ZCode 桌面版自带) */
function zcodeCliPath(): string {
  return (
    process.env.ZCODE_CLI_PATH ??
    "C:/Program Files/ZCode/resources/glm/zcode.cjs"
  );
}

export const zcodeAgentService: ServiceDefinition<
  ZcodeAgentRequest,
  ZcodeAgentResponse
> = {
  id: "@orchestration/zcode-agent",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "ZCode CLI 编码代理：headless 模式驱动 ZCode 执行编码任务",
};

/** 消费声明（与 codex-agent 一样, 任务执行自身不依赖认知层; 模型访问在 CLI 侧） */
export const zcodeAgentRef: CapabilityRef = {
  id: "@orchestration/zcode-agent",
  versionRange: "^1.0.0",
};

// ── Provider 实现 ────────────────────────────────────────────────

const zcodeAgentProvider: Provider<ZcodeAgentRequest, ZcodeAgentResponse> = {
  service: zcodeAgentService,
  name: "orchestration-zcode-agent",
  state: PluginState.Active,
  async execute(
    request: ZcodeAgentRequest,
    ctx: SeamContext,
  ): Promise<Result<ZcodeAgentResponse>> {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      return err("zcode-agent: request.prompt is required and must be non-empty");
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_ZCODE_TIMEOUT_MS;
    // 默认 yolo: 网页应用生成需要自动写盘; build 模式对非 workspace 目录禁止写。
    // 可用 ZCODE_AGENT_MODE 覆盖 (build | edit | yolo)。
    const mode = (request.mode ??
      (process.env.ZCODE_AGENT_MODE as "build" | "edit" | "yolo" | undefined) ??
      "yolo");

    ctx.emit({
      type: "zcode-agent.spawn",
      layer: LayerId.Orchestration,
      payload: { cwd: request.cwd, mode },
      traceId: ctx.traceId,
    });

    // node.exe 是真实可执行文件, Windows 上无需 shell 即可 spawn (避开 .cmd 限制)
    const args = [
      zcodeCliPath(),
      "-p",
      prompt,
      "--cwd",
      request.cwd ?? process.cwd(),
      "--mode",
      mode,
    ];

    backupHtmlFiles(request.cwd ?? process.cwd(), "zcode");
    return new Promise<Result<ZcodeAgentResponse>>((resolve) => {
      const child = spawn(process.env.ZCODE_NODE_BIN ?? "node", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        cwd: request.cwd,
      });

      let resolved = false;
      const finish = (result: Result<ZcodeAgentResponse>): void => {
        if (resolved) return;
        resolved = true;
        if (!child.killed) child.kill("SIGTERM");
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish(err(`zcode-agent: timed out after ${timeoutMs}ms`));
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
        finish(err(`zcode-agent: failed to spawn zcode: ${e.message}`));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-5).join("\n");
          finish(
            err(
              `zcode-agent: zcode exited with code ${code}${tail ? `: ${tail}` : text ? `: ${text.slice(-500)}` : ""}`,
            ),
          );
          return;
        }
        if (!text) {
          finish(err("zcode-agent: zcode produced no output"));
          return;
        }
        finish(
          ok({
            text,
            driver: "zcode",
          }),
        );
      });
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: `zcode-agent ready (cli: ${zcodeCliPath()})`,
      checkedAt: new Date().toISOString(),
    };
  },
};

function err(error: string): Result<never> {
  return { ok: false, error };
}

export { zcodeAgentProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@orchestration/zcode-agent",
  layer: LayerId.Orchestration,
  description: "编排层：ZCode CLI 编码代理 (headless)",
  version: "0.1.0",
  provides: [zcodeAgentService],
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
    return [zcodeAgentProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
