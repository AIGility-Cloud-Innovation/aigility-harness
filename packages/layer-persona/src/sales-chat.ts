/**
 * L3 感知交互层: 销售客服角色形象 (sales-chat)
 *
 * L3 的职责: 构建主体形象，接收信号，委托 L4 编排，由同一角色反馈。
 * 不关心调什么工具、走什么流程——那是 L4 的事。
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

// ── 服务定义 ─────────────────────────────────────────────────────

export interface SalesChatRequest {
  /** 用户输入 */
  user_input: string;
  /** 商户 ID */
  merchant_id?: string;
  /** 客户 ID */
  customer_id?: string;
  /** 会话 ID (可选) */
  session_id?: string;
}

export interface SalesChatResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const salesChatService: ServiceDefinition<SalesChatRequest, SalesChatResponse> = {
  id: "@persona/sales-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "文字对话方角色形象：收消息 → 委托 L4 → 回文字",
};

// ── Provider 实现 ────────────────────────────────────────────────

const salesChatProvider: Provider<SalesChatRequest, SalesChatResponse> = {
  service: salesChatService,
  name: "persona-sales-chat-text",
  state: PluginState.Active,
  async execute(
    request: SalesChatRequest,
    ctx: SeamContext,
  ): Promise<Result<SalesChatResponse>> {
    // 1. 角色形象: "我是销售客服AI"
    const agentName = "销售客服AI";

    // 2. 构建 ChatRequest (带角色身份)
    const chatRequest = {
      user_input: request.user_input,
      merchant_id: request.merchant_id ?? "default",
      customer_id: request.customer_id ?? "anonymous",
      session_id: request.session_id ?? ctx.sessionId,
      agent_name: agentName,
    };

    // 3. 委托 L4 编排 (L4 决定调什么工具、走什么流程)
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      chatRequest,
    );

    // 4. 由同一个角色形象反馈
    const response = (result as { ok: boolean; value?: unknown }).ok
      ? ((result as { value: { result?: string; response?: string } }).value?.result ??
        (result as { value: { response?: string } }).value?.response ??
        "抱歉，我没有理解您的意思。")
      : "抱歉，智能助理暂时无法响应，请稍后重试。";

    return ok({
      response,
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "sales-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { salesChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/sales-chat",
  layer: LayerId.Persona,
  description: "感知层：文字对话方角色形象",
  version: "0.1.0",
  provides: [salesChatService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
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
    return [salesChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
