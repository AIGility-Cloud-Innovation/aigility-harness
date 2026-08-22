/**
 * @aigility-arch/layer-perception — 多模态感知交互层
 *
 * 提供文本输入能力（@perception/text-input）。
 * 原型模式下对输入文本做归一化（trim + 元数据）。
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
  name: "@perception/text-input",
  layer: LayerId.Perception,
  description: "感知交互层：文本输入归一化",
  version: "0.1.0",
  provides: [textInputService],
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
    return [textInputProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
