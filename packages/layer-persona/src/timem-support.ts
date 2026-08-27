/**
 * L2 角色人格层: TiMEM Space 客服角色形象 (timem-support)
 *
 * 职责: 向用户解答 TiMEM Space（太忆空间）产品问题 — 功能/用法/部署/计费。
 *      收问题 → 带 TiMEM 产品知识人设 → 委托 L3 workflow(llm_node) → 回传。
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

export interface TimemSupportRequest {
  /** 用户输入 */
  user_input: string;
  /** 会话 ID (可选) */
  session_id?: string;
}

export interface TimemSupportResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const timemSupportService: ServiceDefinition<TimemSupportRequest, TimemSupportResponse> = {
  id: "@persona/timem-support",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "TiMEM Space 客服角色形象：收问题 → 委托 workflow(llm_node) → 回产品解答",
};

// ── 角色人设提示词 ────────────────────────────────────────────────

const TIMEM_SUPPORT_SYSTEM_PROMPT = `你是「TiMEM Space 客服」，为 TiMEM Space（太忆空间）产品提供专业、友好的客户支持。

## 产品是什么
TiMEM Space（太忆空间）是「智能体时代的个人记忆引擎」——跨 Agent 管理你的记忆，并以前瞻预测让记忆先一步为你工作。面向专业知识型工作者与开发者，把「记忆」从聊天副产品变成可管理、可召回、可蒸馏、可行动的个人资产。

## 核心功能
1. 记忆管理：跨 Agent 统一管理个人记忆（L1-L5 分级记忆），可搜索、召回、蒸馏、沉淀
2. 规则引擎：经验规则的创建、召回与自动化应用，让优质实践沉淀复用
3. 对话：与记忆引擎对话，智能问答
4. 连接器：接入企业微信等多个渠道，随时随地记录与调用记忆
5. 积分系统：用量管理、付费与配额
6. 用户画像：基于记忆自动构建个人画像

## 技术栈
- 前端: React 19 + Vite 7 + Tailwind CSS + shadcn/ui
- 后端: FastAPI + SQLAlchemy + PostgreSQL + Redis + Celery
- 向量库: Qdrant / Chroma（RAG 召回）
- 部署: Docker Compose 一键部署（前端 Nginx + FastAPI + PG + Redis + 队列 + Worker）

## 回答要求
- 先给结论，再展开细节
- 涉及具体配置/部署命令时给出实际可用的指引
- 无法确定的问题如实说明"需要查证后答复"，绝不编造
- 回答简洁、专业、有服务意识
- 中文回答`;

// ── Provider 实现 ────────────────────────────────────────────────

const timemSupportProvider: Provider<TimemSupportRequest, TimemSupportResponse> = {
  service: timemSupportService,
  name: "persona-timem-support-text",
  state: PluginState.Active,
  async execute(
    request: TimemSupportRequest,
    ctx: SeamContext,
  ): Promise<Result<TimemSupportResponse>> {
    // 1. 角色形象: TiMEM 客服
    const agentName = "TiMEM 客服";

    // 2. 构建带产品知识人设的请求
    const supportRequest = {
      user_input: request.user_input,
      session_id: request.session_id ?? ctx.sessionId,
      system_prompt: TIMEM_SUPPORT_SYSTEM_PROMPT,
    };

    // 3. 委托 L3 workflow（llm_node 真实回答, 独立 workflow-engine-timem 实例）
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine-timem", versionRange: "^1.0.0" },
      supportRequest,
    );

    // 4. 从编排结果提取回复
    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: { result?: string; response?: string } }).value
      : undefined;

    const response = value?.result ?? value?.response ?? "抱歉，我没有理解您的意思，请换个方式再问。";

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
      detail: "timem-support ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { timemSupportProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/timem-support",
  layer: LayerId.Persona,
  description: "角色人格层：TiMEM Space 客服角色形象",
  version: "0.1.0",
  provides: [timemSupportService],
  consumes: [{ id: "@orchestration/workflow-engine-timem", versionRange: "^1.0.0" }],
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
    return [timemSupportProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};