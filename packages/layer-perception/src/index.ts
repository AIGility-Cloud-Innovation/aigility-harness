/**
 * @aigility-harness/layer-perception — 多模态感知交互层
 *
 * 提供文本输入能力（@perception/text-input）。
 * 原型模式下对输入文本做归一化（trim + 元数据）。
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

export {
  speechToTextService,
  voskSttProvider,
  whisperSttProvider,
  VOSK_MODEL_PATH,
  WHISPER_MODEL_ID,
} from "./speech-to-text.js";
export type {
  SpeechToTextRequest,
  SpeechToTextResponse,
} from "./speech-to-text.js";
import {
  speechToTextService,
  voskSttProvider,
  whisperSttProvider,
} from "./speech-to-text.js";

// 角色形象插件
export {
  chatAgentService,
  chatAgentProvider,
} from "./chat-agent.js";
export type {
  ChatAgentRequest,
  ChatAgentResponse,
} from "./chat-agent.js";
import { chatAgentService, chatAgentProvider } from "./chat-agent.js";

// 就业数据顾问角色形象 (CareerEdu)
export {
  advisoryChatService,
  advisoryChatProvider,
} from "./advisory-chat.js";
export type {
  AdvisoryChatRequest,
  AdvisoryChatResponse,
} from "./advisory-chat.js";
import { advisoryChatService, advisoryChatProvider } from "./advisory-chat.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface TextInputRequest {
  /** 原始文本 */
  text: string;
  /** 可选来源标记 */
  source?: string;
}

export interface TextInputResponse {
  /** 归一化后的文本 */
  normalized: string;
  /** 字符数 */
  length: number;
  source: string;
}

export const textInputService: ServiceDefinition<
  TextInputRequest,
  TextInputResponse
> = {
  id: "@perception/text-input",
  version: "1.0.0",
  layer: LayerId.Perception,
  description: "文本输入归一化能力",
};

// ── Provider 实现 ────────────────────────────────────────────────

const textInputProvider: Provider<TextInputRequest, TextInputResponse> = {
  service: textInputService,
  name: "perception-text-input-basic",
  state: PluginState.Active,
  async execute(
    request: TextInputRequest,
    _ctx: SeamContext,
  ): Promise<Result<TextInputResponse>> {
    const normalized = request.text.trim();
    return ok({
      normalized,
      length: normalized.length,
      source: request.source ?? "unknown",
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "text input ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@perception/multimodal-input",
  layer: LayerId.Perception,
  description: "感知交互层：文本输入归一化 + 语音转文本（ASR）",
  version: "0.2.0",
  provides: [textInputService, speechToTextService, advisoryChatService],
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
    return [
      textInputProvider,
      voskSttProvider,
      whisperSttProvider,
      chatAgentProvider,
      advisoryChatProvider,
    ];
  },
  getState(): PluginState {
    return pluginState;
  },
};
