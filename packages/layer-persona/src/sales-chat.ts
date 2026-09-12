/**
 * L3 感知交互层: 平台客服角色形象 (sales-chat)
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
  /** 会话历史 (前端维护, 透传给编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
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
  /** true = LLM 不可用, 本次回复来自降级 stub */
  degraded?: boolean;
}

export const salesChatService: ServiceDefinition<SalesChatRequest, SalesChatResponse> = {
  id: "@persona/sales-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "平台客服角色形象：解答系统使用问题 → 委托 L4 → 回文字",
};

// ── Provider 实现 ────────────────────────────────────────────────

// ── Provider 实现 ────────────────────────────────────────────────

/** AppBase 系统知识 (客服的产品手册, 随提问注入 LLM) */
const APPBASE_SUPPORT_PROMPT = [
  '你是「平台客服」, 专门解答用户关于 AppBase 系统的任何问题。请用简体中文回答。',
  '',
  '【AppBase 是什么】一个 AI 应用工厂: 大厅里可以打开 AI 生成的网页应用、与对话角色聊天、在编码工作台让 AI 修改应用代码。',
  '',
  '【核心功能】',
  '1. 应用大厅 (/hall): 卡片墙展示所有应用。每个应用可打开、设置(可登录账号 / LLM 配置 / .env 配置)。',
  '2. 对话角色: 网页应用开发员(生成 HTML 应用, 编辑模式)、编码教练(教学模式, 只讲不改代码), 两者都在编码工作台里; 另有平台客服(本角色)。',
  '3. 编码工作台 (/hall/workbench): 选角色 + 目标应用 + 编码工具(Codex CLI / ZCode CLI / Claude Code, 自动检测本机可用性), AI 直接修改应用代码; 改动前自动快照备份到 .backups(保留10份); 聊天记录按 角色+应用+工具 自动保存。',
  '4. 应用账号: 每个应用可有独立的用户名+密码账号(管理员在大厅设置里添加), 用户名登录, 可自助改密或由管理员重置。',
  '5. LLM 配置: 每个应用可单独配置 LLM 上游(URL / API Key / 模型, 可从上游拉取模型列表), Key 保存在服务端, 应用前端不接触; AI 调用走服务端代理。未配置的应用回退全局默认。',
  '6. .env 配置: 每个应用可有额外 KEY=VALUE 配置, 应用运行时通过 window.APP_ENV 读取。',
  '7. 班主任小本本 (teacher-notebook): 内置演示应用 —— 班级管理: 名册(批量导入)、考勤(出勤/迟到/请假/缺勤)、记忆本(AI 结构化记录学生行为/纪律/成绩/交际)、学生画像(四维聚合+时间线+AI提示词导出)、随机点名、积分(积分必须经由记忆本记录产生)。',
  '',
  '【常见问题】',
  '- 打开应用提示 401/未授权: 需要登录该应用的账号; 账号由管理员在大厅设置里添加。',
  '- AI 功能报错: 检查大厅设置里该应用的 LLM 配置, 或管理员未配置上游。',
  '- 数据在哪: 登录后实时同步到云端 PostgreSQL, 换设备登录同一账号即可恢复; 未登录时只存浏览器本地。',
  '',
  '回答原则: 结论先行、具体可操作; 不知道的功能如实说, 不编造。',
].join("\n");

const salesChatProvider: Provider<SalesChatRequest, SalesChatResponse> = {
  service: salesChatService,
  name: "persona-sales-chat-text",
  state: PluginState.Active,
  async execute(
    request: SalesChatRequest,
    ctx: SeamContext,
  ): Promise<Result<SalesChatResponse>> {
    // 1. 角色形象: "我是销售客服AI"
    const agentName = "平台客服";

    // 2. 构建 ChatRequest (带角色身份 + 会话记忆透传)
    const chatRequest = {
      user_input: request.user_input,
      merchant_id: request.merchant_id ?? "default",
      customer_id: request.customer_id ?? "anonymous",
      session_id: request.session_id ?? ctx.sessionId,
      agent_name: agentName,
      system_prompt: APPBASE_SUPPORT_PROMPT,
      ...(request.history?.length ? { history: request.history } : {}),
    };

    // 3. 委托 L4 编排 (L4 决定调什么工具、走什么流程)
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      chatRequest,
    );

    // 4. 由同一个角色形象反馈
    const wfValue = (result as { ok: boolean; value?: { result?: string; response?: string; degraded?: boolean } })
      .value;
    const response = (result as { ok: boolean }).ok
      ? (wfValue?.result ?? wfValue?.response ?? "抱歉，我没有理解您的意思。")
      : "抱歉，智能助理暂时无法响应，请稍后重试。";

    return ok({
      response,
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(wfValue?.degraded ? { degraded: true } : {}),
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
