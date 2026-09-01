/**
 * L3 角色人格层: TiMEM Space 客服角色形象 (timem-support)
 *
 * 职责: 向用户解答 TiMEM Space（太忆空间）产品问题 — 功能/用法/计费。
 *      收问题 → 带 TiMEM 产品知识人设 → 委托 L4 workflow(llm_node) → 回传。
 *      注: 实际生效的客服提示词在 aigility 仓库 aigility/timem_support_prompts.py
 *      (workflow llm_node 经 prompt_ref 引用)，此处常量仅作角色描述参考。
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
  /** 用户 ID (企微 userid, 用于记忆隔离) */
  user_id?: string;
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
TiMEM Space（太忆空间）是「智能体时代的个人记忆引擎」：跨 Agent 管理你的记忆，并以前瞻预测让记忆先一步为你工作。面向专业知识型工作者与开发者，把记忆从聊天副产品变成可管理、可召回、可蒸馏、可行动的个人资产。

## 产品形态（重要）
- 太忆空间是**网页应用**：无需安装、无需自行部署，打开网址 **space.timem.cloud** 即可注册使用
- 网页端（React 19 + Vite 7 + Tailwind），后端提供认证 / 记忆 / 召回 / 对话 / 规则 / 连接 / 积分 / 画像等能力

## 连接器（重要，如实回答）
TiMEM Space 通过「连接器」为各类 Agent 建立记忆云席位，**全部基于 MCP 协议**，支持模板包括：
- Claude Desktop（桌面对话助手）
- Codex（云端编程智能体）
- Claude Code（终端编程智能体）
- WorkBuddy（办公协作智能体）
- OpenClaw（开源个人智能体）
- Hermes（轻量任务智能体）
- Trae / Cursor / Windsurf / Qoder（AI IDE 与编程平台）
- 豆包（字节跳动 AI 助手）
- 其他（通用 MCP 客户端）

## 回答要求
- 只回答基于上述产品事实的问题；涉及连接渠道、功能清单等,严格以「MCP 连接器模板」体系为准,绝不编造不存在的集成（如微信/飞书 IM 渠道）
- **涉及"部署/自建/私有化/本地运行/离线安装/自己搭建"等话题：不要展开、不要使用"支持/不支持部署、可以/不可以部署、需要/不需要部署、无需安装/无需部署"等判断句式**，唯一话术："太忆空间是一款网页应用，网址是 **space.timem.cloud**"，说完直接自然引导回功能/连接器/使用问题
- 不确定的细节（某功能是否上线、具体版本）如实说"需要查证官方文档",不要猜测
- 先给结论再展开,回答简洁友好
- 用户问连接哪个 Agent: 从上述模板列表里回答,引导其选择对应 MCP 模板`;

// ── Provider 实现 ────────────────────────────────────────────────

// 瞬时记忆环: 每个用户的最近 N 轮对话 [role: "user"|"assistant", content]
const RECENT_TURNS = 2;
const recentRings = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

function pushTurn(userId: string, turn: { role: "user" | "assistant"; content: string }): void {
  const ring = recentRings.get(userId) ?? [];
  ring.push(turn);
  // 只保留最近 RECENT_TURNS 轮 (2 轮 = 4 条 message)
  while (ring.length > RECENT_TURNS * 2) ring.shift();
  recentRings.set(userId, ring);
}

function formatHistory(userId: string): string {
  const ring = recentRings.get(userId) ?? [];
  if (ring.length === 0) return "";
  const lines = ring.map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`);
  return lines.join("\n");
}

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
    const userId = request.user_id ?? "wecom-unknown";

    // 2. 构建带产品知识人设 + 最近对话上下文的请求
    const supportRequest = {
      user_input: request.user_input,
      user_id: userId,
      agent_id: "timem-support",   // 本客服的 agent 标识 (记忆隔离)
      session_id: request.session_id ?? ctx.sessionId,
      system_prompt: TIMEM_SUPPORT_SYSTEM_PROMPT,
      // 瞬时记忆: 最近 2 轮对话 (用户说过的短词如 "trae"/"需要" 依赖此上下文)
      recent_history: formatHistory(userId),
    };

    // 3. 委托 L4 workflow（llm_node 真实回答, 独立 workflow-engine-timem 实例）
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine-timem", versionRange: "^1.0.0" },
      supportRequest,
    );

    // 4. 从编排结果提取回复
    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: { result?: string; response?: string } }).value
      : undefined;

    const response = value?.result ?? value?.response ?? "抱歉，我没有理解您的意思，请换个方式再问。";

    // 4.5 更新瞬时记忆环: 本轮 Q&A 入环 (下次提问携带)
    pushTurn(userId, { role: "user", content: request.user_input });
    pushTurn(userId, { role: "assistant", content: response });

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