/**
 * @orchestration/claude-agent — Claude Code CLI 编码代理能力
 *
 * 通过 Claude Code CLI 的 headless 模式 (`claude -p <prompt>`) 驱动 Claude 执行编码任务，
 * 与 codex-agent / zcode-agent 平级，作为网页应用开发员的可切换工具之一。
 *
 * Windows: claude 是 npm .cmd 包装, 必须经 shell spawn (Node 禁止无 shell 直接 spawn .cmd);
 *          参数含空格时需自行加引号。
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
import { backupHtmlFiles } from "./sandbox-backup.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface ClaudeAgentRequest {
  /** 编码任务提示词 (含角色人设与工作目录约束) */
  prompt: string;
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒 (默认 10 分钟) */
  timeoutMs?: number;
}

export interface ClaudeAgentResponse {
  /** Claude 最终输出的文本 */
  text: string;
  /** 驱动标识 */
  driver: "claude";
}

export const DEFAULT_CLAUDE_TIMEOUT_MS = 600_000; // 10 min

/** spawn cwd 必须是目录: 传入的是 .html 文件时取其所在目录 */
function resolveAgentCwd(cwd?: string): string {
  const target = cwd ?? process.cwd();
  try {
    if (existsSync(target) && statSync(target).isFile()) return dirname(target);
  } catch { /* ignore */ }
  return target;
}

export const claudeAgentService: ServiceDefinition<
  ClaudeAgentRequest,
  ClaudeAgentResponse
> = {
  id: "@orchestration/claude-agent",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "Claude Code CLI 编码代理：headless 模式驱动 Claude 执行编码任务",
};

export const claudeAgentRef: CapabilityRef = {
  id: "@orchestration/claude-agent",
  versionRange: "^1.0.0",
};

const claudeAgentProvider: Provider<ClaudeAgentRequest, ClaudeAgentResponse> = {
  service: claudeAgentService,
  name: "orchestration-claude-agent",
  state: PluginState.Active,
  async execute(
    request: ClaudeAgentRequest,
    ctx: SeamContext,
  ): Promise<Result<ClaudeAgentResponse>> {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      return err("claude-agent: request.prompt is required and must be non-empty");
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;

    ctx.emit({
      type: "claude-agent.spawn",
      layer: LayerId.Orchestration,
      payload: { cwd: request.cwd },
      traceId: ctx.traceId,
    });

    // Windows: claude 是 .cmd, 必须 shell spawn; 参数含空格自行加引号
    const useShell = process.platform === "win32";
    const args = [
      "-p",
      useShell && prompt.includes(" ") ? `"${prompt}"` : prompt,
      "--cwd",
      resolveAgentCwd(request.cwd),
      "--permission-mode",
      "acceptEdits",
    ];

    backupHtmlFiles(request.cwd ?? process.cwd(), "claude");
    return new Promise<Result<ClaudeAgentResponse>>((resolve) => {
      const child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        cwd: resolveAgentCwd(request.cwd),
        shell: useShell,
      });

      let resolved = false;
      const finish = (result: Result<ClaudeAgentResponse>): void => {
        if (resolved) return;
        resolved = true;
        if (!child.killed) child.kill("SIGTERM");
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish(err(`claude-agent: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

      child.on("error", (e: Error) => {
        clearTimeout(timer);
        finish(err(`claude-agent: failed to spawn claude: ${e.message}`));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code !== 0 && !text) {
          const tail = stderr.trim().split("\n").slice(-5).join("\n");
          finish(err(`claude-agent: claude exited with code ${code}${tail ? `: ${tail}` : ""}`));
          return;
        }
        if (!text) finish(err("claude-agent: claude produced no output"));
        else finish(ok({ text, driver: "claude" }));
      });
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "claude-agent ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

function err(error: string): Result<never> {
  return { ok: false, error };
}

export { claudeAgentProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@orchestration/claude-agent",
  layer: LayerId.Orchestration,
  description: "编排层：Claude Code CLI 编码代理 (headless)",
  version: "0.1.0",
  provides: [claudeAgentService],
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
    return [claudeAgentProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
