/**
 * @aigility-arch/layer-cognitive — 认知决策核心层
 *
 * 提供 LLM 推理占位能力（@cognitive/llm-inference）。
 * 原型模式下返回确定性占位回复，不调用真实模型。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-arch/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface LlmInferenceRequest {
  prompt: string;
  /** 可选的系统提示 */
  systemPrompt?: string;
  /** 最大生成 token 数 */
  maxTokens?: number;
}

export interface LlmInferenceResponse {
  text: string;
  /** 实际生成的 token 数（占位） */
  tokens: number;
  model: string;
}

export const llmInferenceService: ServiceDefinition<
  LlmInferenceRequest,
  LlmInferenceResponse
> = {
  id: "@cognitive/llm-inference",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "LLM 推理能力（原型占位，返回确定性回复）",
};

// ── Provider 实现 ────────────────────────────────────────────────

const llmInferenceProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> =
  {
    service: llmInferenceService,
    name: "cognitive-llm-inference-stub",
    state: PluginState.Active,
    async execute(
      request: LlmInferenceRequest,
      _ctx: SeamContext,
    ): Promise<Result<LlmInferenceResponse>> {
      const text = `[stub-llm] echo: ${request.prompt}`;
      return ok({
        text,
        tokens: text.length,
        model: "stub-llm@0.1.0",
      });
    },
    async health(): Promise<HealthStatus> {
      return {
        healthy: true,
        detail: "stub llm inference ready",
        checkedAt: new Date().toISOString(),
      };
    },
  };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@cognitive/llm-inference",
  layer: LayerId.Cognitive,
  description: "认知核心层：LLM 推理占位",
  version: "0.1.0",
  provides: [llmInferenceService],
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
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [llmInferenceProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
