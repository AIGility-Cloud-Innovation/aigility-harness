/**
 * @aigility-harness/layer-action — 行动执行工具层
 *
 * 提供工具执行占位能力（@action/tool-execution）。
 * 行动层是链路末端，执行编排层交付的具体操作，不反向消费编排能力。
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
} from "@aigility-harness/core";
import {
  textToSpeechService,
  textToSpeechProvider,
  type TextToSpeechRequest,
  type TextToSpeechResponse,
} from "./text-to-speech.js";
import {
  codexAgentService,
  codexAgentProvider,
  type CodexAgentRequest,
  type CodexAgentResponse,
  type CodexAgentItem,
  type CodexAgentTurnUsage,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codex-agent.js";
import {
  zcodeAgentService,
  zcodeAgentProvider,
  zcodeAgentRef,
  type ZcodeAgentRequest,
  type ZcodeAgentResponse,
} from "./zcode-agent.js";
import {
  claudeAgentService,
  claudeAgentProvider,
  claudeAgentRef,
  type ClaudeAgentRequest,
  type ClaudeAgentResponse,
} from "./claude-agent.js";

export { textToSpeechService, textToSpeechProvider };
export type { TextToSpeechRequest, TextToSpeechResponse };

// 编码代理工人（D5：领活 → 执行 → 交产出，spawn CLI 子进程产生真实副作用）
export { codexAgentService, codexAgentProvider };
export type {
  CodexAgentRequest,
  CodexAgentResponse,
  CodexAgentItem,
  CodexAgentTurnUsage,
  CodexApprovalPolicy,
  CodexSandboxMode,
};
export { zcodeAgentService, zcodeAgentProvider, zcodeAgentRef };
export { claudeAgentService, claudeAgentProvider, claudeAgentRef };
export type { ZcodeAgentRequest, ZcodeAgentResponse };
export type { ClaudeAgentRequest, ClaudeAgentResponse };

// 沙箱快照备份工具（编码代理改文件前自动快照；版本回滚 UI 复用）
export { backupHtmlFiles } from "./sandbox-backup.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface ToolExecutionRequest {
  /** 工具名称 */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
}

export interface ToolExecutionResponse {
  result: unknown;
  success: boolean;
  executedTool: string;
}

export const toolExecutionService: ServiceDefinition<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  id: "@action/tool-execution",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "工具执行能力（原型占位，返回参数回显）",
};

// ── Provider 实现 ────────────────────────────────────────────────

const toolExecutionProvider: Provider<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  service: toolExecutionService,
  name: "action-tool-execution-stub",
  state: PluginState.Active,
  async execute(
    request: ToolExecutionRequest,
    _ctx: SeamContext,
  ): Promise<Result<ToolExecutionResponse>> {
    // 占位执行：回显工具名与参数
    return ok({
      result: { echoedArgs: request.args },
      success: true,
      executedTool: request.tool,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub tool execution ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/tool-execution",
  layer: LayerId.Action,
  description: "行动执行层：工具执行占位 + 文本转语音 + 编码代理工人(codex/zcode/claude)",
  version: "0.3.0",
  provides: [toolExecutionService, textToSpeechService, codexAgentService, zcodeAgentService, claudeAgentService],
  consumes: [],
  preferredCarrier: CarrierKind.Subprocess,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [toolExecutionProvider, textToSpeechProvider, codexAgentProvider, zcodeAgentProvider, claudeAgentProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
