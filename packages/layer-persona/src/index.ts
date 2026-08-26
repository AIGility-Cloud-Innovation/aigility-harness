/**
 * @aigility-harness/layer-persona — 角色人格层
 *
 * 提供文本输入能力（@persona/text-input）。
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

// 销售客服角色形象
export {
  salesChatService,
  salesChatProvider,
} from "./sales-chat.js";
export type {
  SalesChatRequest,
  SalesChatResponse,
} from "./sales-chat.js";
import { salesChatService, salesChatProvider } from "./sales-chat.js";

// 框架介绍员角色形象
export {
  harnessGuideService,
  harnessGuideProvider,
} from "./harness-guide.js";
export type {
  HarnessGuideRequest,
  HarnessGuideResponse,
} from "./harness-guide.js";
import { harnessGuideService, harnessGuideProvider } from "./harness-guide.js";

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

// 插件安装助手角色形象 (开箱即用引导)
export {
  pluginHelperService,
  pluginHelperProvider,
} from "./plugin-helper.js";
export type {
  PluginHelperRequest,
  PluginHelperResponse,
} from "./plugin-helper.js";
import { pluginHelperService, pluginHelperProvider } from "./plugin-helper.js";

// 编码助手角色形象 (实现无关, 委托 L3 编码 Agent)
export {
  coderService,
  coderProvider,
} from "./coder.js";
export type {
  CoderRequest,
  CoderResponse,
} from "./coder.js";
import { coderService, coderProvider } from "./coder.js";

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
  id: "@persona/text-input",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "文本输入归一化能力",
};

// ── Provider 实现 ────────────────────────────────────────────────

const textInputProvider: Provider<TextInputRequest, TextInputResponse> = {
  service: textInputService,
  name: "persona-text-input-basic",
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
  name: "@persona/character",
  layer: LayerId.Persona,
  description: "角色人格层：感知（文本/语音）+ 角色形象（sales-chat/plugin-helper/coder/advisory-chat/harness-guide）",
  version: "0.3.0",
  provides: [textInputService, speechToTextService, salesChatService, pluginHelperService, coderService, advisoryChatService, harnessGuideService],
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
      salesChatProvider,
      pluginHelperProvider,
      coderProvider,
      advisoryChatProvider,
      harnessGuideProvider,
    ];
  },
  getState(): PluginState {
    return pluginState;
  },
};
