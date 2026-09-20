/**
 * L3 感知交互层: 备课助理角色形象 (lesson-prep-chat)
 *
 * 服务于「教师备课夹」的备课问答助手, 与「班主任小本本」的班班助理 (banban-chat) 同构:
 *   - 前端注入【课程与教材快照】(课程/章节/教材切片量/已有教案与材料概览)
 *   - 记忆召回/沉淀作为流内标准节点下沉编排域 (workflow-engine request.memory)
 *   - 记忆按老师邮箱隔离 (agent_id=lesson-prep), 跨会话可召回
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

export interface LessonPrepChatRequest {
  /** 老师的提问 */
  user_input: string;
  /** 会话 ID (可选) */
  session_id?: string;
  /** 老师标识 (大厅登录邮箱; TiMEM 记忆按此隔离) */
  user_key?: string;
  /** 课程与教材快照 (应用前端组装: 课程/章节/切片/教案/材料概览) */
  course_context?: string;
  /** 请求级 LLM 上游覆盖 (应用自带 LLM 配置, 缺省走全局) */
  llm?: {
    url?: string;
    key?: string;
    model?: string;
  };
  /** 会话历史 (前端维护, 透传编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface LessonPrepChatResponse {
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

export const lessonPrepChatService: ServiceDefinition<LessonPrepChatRequest, LessonPrepChatResponse> = {
  id: "@persona/lesson-prep-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "备课助理：基于课程教材快照 + TiMEM 长期记忆的教师备课问答助手",
};

// ── Provider 实现 ────────────────────────────────────────────────

const LESSON_PREP_PROMPT = [
  "你是「备课助理」, 一位懂教学的备课顾问, 服务于「教师备课夹」应用的一线教师。",
  "老师会问你备课相关的问题 (教案设计、课型选择、重难点处理、讲义/练习/课件的组织、思政融入等),",
  "请基于下方提供的课程与教材快照和你的教学经验来回答。",
  "",
  "要求:",
  "- 用简体中文, 语气专业友善, 结论先行, 建议要具体可落地 (给出可以直接用的教学环节/活动设计)。",
  "- 只依据【课程与教材快照】和【历史记忆】谈论具体课程内容; 快照里没有的教材内容如实说「教材里没有」, 不编造教材原文与数据。",
  "- 涉及课型建议时区分: 标准课 / 实训课 / 思政示范课 / 复习课, 并说明理由。",
  "- 提醒老师: 正式教案与讲义请用应用里的「生成教案/生成材料」能力产出 (带教材溯源), 你这里给的是设计建议。",
].join("\n");

const lessonPrepChatProvider: Provider<LessonPrepChatRequest, LessonPrepChatResponse> = {
  service: lessonPrepChatService,
  name: "persona-lesson-prep-chat-text",
  state: PluginState.Active,
  async execute(
    request: LessonPrepChatRequest,
    ctx: SeamContext,
  ): Promise<Result<LessonPrepChatResponse>> {
    const agentName = "备课助理";
    const memUserId = request.user_key ?? "anonymous";

    const contextBlock = request.course_context
      ? `\n\n【课程与教材快照】(当前备课概览, 由应用前端注入)\n${request.course_context.slice(0, 12000)}`
      : "\n\n【课程与教材快照】(暂无数据)";
    const systemPrompt = LESSON_PREP_PROMPT + contextBlock;

    const result = (await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      {
        user_input: request.user_input,
        session_id: request.session_id ?? ctx.sessionId,
        user_key: memUserId,
        agent_name: agentName,
        system_prompt: systemPrompt,
        memory: { agent_id: "lesson-prep", user_id: memUserId, limit: 4 },
        ...(request.llm ? { llm: request.llm } : {}),
        ...(request.history?.length ? { history: request.history } : {}),
      },
    )) as { ok: boolean; value?: { result?: string; response?: string; degraded?: boolean } };

    const wfValue = (result as { value?: { result?: string; response?: string; degraded?: boolean } }).value;
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
      detail: "lesson-prep-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { lessonPrepChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/lesson-prep-chat",
  layer: LayerId.Persona,
  description: "感知层：备课助理角色形象（备课问答 + 流内 TiMEM 记忆）",
  version: "0.1.0",
  provides: [lessonPrepChatService],
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
    return [lessonPrepChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
