/**
 * L3 感知交互层: 班班助理角色形象 (banban-chat)
 *
 * 服务于「班主任小本本」的班级数据问答助手。角色域只负责人设与上下文装配:
 *   - 前端注入【班级实时数据】(名册/记忆本/考试成绩/考勤快照)
 *   - 记忆召回/沉淀作为流内标准节点下沉编排域 (workflow-engine request.memory)
 *   - 记忆按老师邮箱隔离 (agent_id=banban-assist), 跨会话可召回
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

export interface BanbanChatRequest {
  /** 老师的提问 */
  user_input: string;
  /** 会话 ID (可选) */
  session_id?: string;
  /** 老师标识 (大厅登录邮箱; TiMEM 记忆按此隔离) */
  user_key?: string;
  /** 班级实时数据快照 (应用前端组装: 名册/记忆本/考试成绩/考勤) */
  class_context?: string;
  /** 请求级 LLM 上游覆盖 (应用自带 LLM 配置, 缺省走全局) */
  llm?: {
    url?: string;
    key?: string;
    model?: string;
  };
  /** 会话历史 (前端维护, 透传编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface BanbanChatResponse {
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

export const banbanChatService: ServiceDefinition<BanbanChatRequest, BanbanChatResponse> = {
  id: "@persona/banban-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "班班助理：基于班级实时数据 + TiMEM 长期记忆的老师问答助手",
};

// ── Provider 实现 ────────────────────────────────────────────────

const BANBAN_PROMPT = [
  "你是「班班助理」, 一位懂教育的班级数据助手, 服务于「班主任小本本」应用的老师。",
  "老师会问你班里学生的情况 (成绩变化、行为表现、考勤、积分等), 请基于下方提供的班级实时数据回答。",
  "",
  "要求:",
  "- 用简体中文, 语气专业友善, 结论先行, 适当给出带数据支撑的教育建议。",
  "- 只依据【班级实时数据】和【历史记忆】回答; 数据里没有的如实说「记录里没有」, 不编造学生和数据。",
  "- 涉及多个学生时点名区分; 提到成绩变化时给出具体分数和方向。",
  "- 涉及学生隐私的分析只呈现给提问的老师本人, 不建议对外传播。",
].join("\n");

const banbanChatProvider: Provider<BanbanChatRequest, BanbanChatResponse> = {
  service: banbanChatService,
  name: "persona-banban-chat-text",
  state: PluginState.Active,
  async execute(
    request: BanbanChatRequest,
    ctx: SeamContext,
  ): Promise<Result<BanbanChatResponse>> {
    const agentName = "班班助理";
    const memUserId = request.user_key ?? "anonymous";

    const contextBlock = request.class_context
      ? `\n\n【班级实时数据】(当前班级快照, 由应用前端注入)\n${request.class_context.slice(0, 12000)}`
      : "\n\n【班级实时数据】(暂无数据)";
    const systemPrompt = BANBAN_PROMPT + contextBlock;

    const result = (await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      {
        user_input: request.user_input,
        session_id: request.session_id ?? ctx.sessionId,
        user_key: memUserId,
        agent_name: agentName,
        system_prompt: systemPrompt,
        memory: { agent_id: "banban-assist", user_id: memUserId, limit: 4 },
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
      detail: "banban-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { banbanChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/banban-chat",
  layer: LayerId.Persona,
  description: "感知层：班班助理角色形象（班级数据问答 + 流内 TiMEM 记忆）",
  version: "0.1.0",
  provides: [banbanChatService],
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
    return [banbanChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
