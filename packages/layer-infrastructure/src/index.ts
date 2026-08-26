/**
 * @aigility-harness/layer-infrastructure — 底座兼容基础层
 *
 * 提供日志（@infrastructure/logging）与配置（@infrastructure/config）
 * 两个能力。原型模式下以内存 Provider 形式运行于 Thread 载体。
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
  protocolAdapterService,
  createProtocolAdapterProvider,
  llmInferenceRef,
} from "./protocol-adapter.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface LoggingRequest {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface LoggingResponse {
  written: boolean;
  timestamp: string;
}

export const loggingService: ServiceDefinition<LoggingRequest, LoggingResponse> =
  {
    id: "@infrastructure/logging",
    version: "1.0.0",
    layer: LayerId.Infrastructure,
    description: "结构化日志能力，按 level 输出到控制台",
  };

export interface ConfigRequest {
  key: string;
}

export interface ConfigResponse {
  value: unknown;
  found: boolean;
}

export const configService: ServiceDefinition<ConfigRequest, ConfigResponse> = {
  id: "@infrastructure/config",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "键值配置读取能力",
};

// ── Provider 实现 ────────────────────────────────────────────────

const loggingProvider: Provider<LoggingRequest, LoggingResponse> = {
  service: loggingService,
  name: "infrastructure-logging-console",
  state: PluginState.Active,
  async execute(
    request: LoggingRequest,
    _ctx: SeamContext,
  ): Promise<Result<LoggingResponse>> {
    const ts = new Date().toISOString();
    const meta = request.meta ? ` ${JSON.stringify(request.meta)}` : "";
    // eslint-disable-next-line no-console
    console.log(`[${ts}] [${request.level.toUpperCase()}] ${request.message}${meta}`);
    return ok({ written: true, timestamp: ts });
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: "console logging ready", checkedAt: new Date().toISOString() };
  },
};

// 内存配置表（原型模式）
const configStore = new Map<string, unknown>([
  ["mode", "prototype"],
  ["maxRetries", 3],
]);

const configProvider: Provider<ConfigRequest, ConfigResponse> = {
  service: configService,
  name: "infrastructure-config-memory",
  state: PluginState.Active,
  async execute(
    request: ConfigRequest,
    _ctx: SeamContext,
  ): Promise<Result<ConfigResponse>> {
    const value = configStore.get(request.key);
    return ok({ value, found: configStore.has(request.key) });
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: "memory config ready", checkedAt: new Date().toISOString() };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@infrastructure/logging-config",
  layer: LayerId.Infrastructure,
  description: "底座基础层：控制台日志 + 内存配置 + 协议适配",
  version: "0.2.0",
  provides: [loggingService, configService, protocolAdapterService],
  consumes: [llmInferenceRef],
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
    return [loggingProvider, configProvider, createProtocolAdapterProvider(), httpIngressProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};

// 重新导出协议适配能力与类型
export {
  protocolAdapterService,
  createProtocolAdapterProvider,
  llmInferenceRef,
} from "./protocol-adapter.js";
export type {
  ProtocolKind,
  ProtocolAdapterRequest,
  ProtocolAdapterResponse,
} from "./protocol-adapter.js";

// HTTP 入口服务
export {
  httpIngressService,
  httpIngressProvider,
  stopHttpServer,
} from "./http-ingress.js";
export type {
  HttpIngressRequest,
  HttpIngressResponse,
} from "./http-ingress.js";
import { httpIngressProvider, httpIngressService } from "./http-ingress.js";

// SSE 帧编码原子模块（http-ingress 流式输出复用；Hono 等备件换装时同款 import）
export {
  SSE_CONTENT_TYPE,
  SSE_DONE,
  encodeSseFrame,
  encodeSseComment,
  writeSseHeaders,
  buildChatChunk,
  encodeChatCompletionStream,
} from "./sse.js";
