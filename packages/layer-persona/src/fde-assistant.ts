/**
 * L3 感知交互层: FDE 数字员工角色形象 (fde-assistant)
 *
 * 服务于「TiMEM FDE 工作台」(examples/fde-workbench) 的开放问答数字员工。
 * 与 banban-chat 同构的角色域分工：
 *   - 角色域只负责人设与上下文装配（业务快照由前端注入）
 *   - 记忆召回/沉淀作为流内标准节点下沉编排域 (workflow-engine request.memory)
 *   - 记忆按工作台登录账号隔离 (agent_id=fde-assistant), 跨会话可召回
 *   - 行动类指令（推进线索/创建提醒/生成方案）由前端本地识别 + 人在回路确认,
 *     本角色只做开放问答, 不直接改工作台数据
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
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface FdeAssistantRequest {
  /** 用户的提问 */
  user_input: string;
  /** 会话 ID (可选, 前端维护) */
  session_id?: string;
  /** 工作台登录账号 (TiMEM 记忆按此隔离) */
  user_key?: string;
  /** 工作台实时数据快照 (前端组装: 线索/方案/合同/交付/续费/任务) */
  business_context?: string;
  /** 会话历史 (前端维护, 透传编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 请求级 LLM 上游覆盖 (缺省走全局) */
  llm?: {
    url?: string;
    key?: string;
    model?: string;
  };
}

export interface FdeAssistantResponse {
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

export const fdeAssistantService: ServiceDefinition<FdeAssistantRequest, FdeAssistantResponse> = {
  id: "@persona/fde-assistant",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "FDE 数字员工：基于工作台实时数据 + TiMEM 长期记忆的开放问答助手（行动指令留在前端人在回路）",
};

// ── 角色人设提示词 ───────────────────────────────────────────────

const FDE_ASSISTANT_PROMPT = [
  "你是「TiMEM 数字员工」, 服务于 TiMEM FDE 工作台 —— 一个面向 FDE (Forward Deployed Engineer) 的交付一体化工作台,",
  "覆盖线索、拜访访谈、方案报价、合同回款、交付部署、渠道分佣、知识沉淀、续费台账等业务环节。",
  "",
  "## 回答要求",
  "- 用简体中文, 结论先行, 专业简洁, 适当给出可执行的下一步建议。",
  "- 优先依据【工作台实时数据】回答; 数据里没有的如实说「台账里没有记录」, 不编造客户、金额与进度。",
  "- 引用数据时点名具体客户/条目, 涉及金额给出数字。",
  "- 提及经验规则或历史沉淀时, 说明它来自知识库且需人工确认后生效。",
  "",
  "## 行为边界（重要）",
  "- 改数据的动作（推进线索阶段、创建提醒/任务、生成方案、登记回款等）不由你执行:",
  "  告诉用户在工作台对应页面操作, 或在数字员工对话里发出明确指令（会生成待确认的行动卡片, 人工确认后才执行）。",
  "- 所有智能产出需人工确认后生效 —— 这是工作台的人机分工原则, 回答中不要承诺你已代为执行。",
  "- 报价与合同金额敏感信息只呈现给已登录的工作台成员。",
].join("\n");

// ── Provider 实现 ────────────────────────────────────────────────

const providerName = "persona-fde-assistant-text";

export const fdeAssistantProvider: Provider<FdeAssistantRequest, FdeAssistantResponse> = {
  service: fdeAssistantService,
  name: providerName,
  state: PluginState.Active,
  async execute(
    request: FdeAssistantRequest,
    ctx: SeamContext,
  ): Promise<Result<FdeAssistantResponse>> {
    const agentName = "TiMEM 数字员工";
    const memUserId = request.user_key ?? "anonymous";

    const contextBlock = request.business_context
      ? `\n\n【工作台实时数据】(当前台账快照, 由前端注入)\n${request.business_context.slice(0, 12000)}`
      : "\n\n【工作台实时数据】(暂无快照)";

    // 委托 L4 编排（记忆召回 → LLM → 沉淀 三段流内编排, 尽力而为）
    const result = (await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      {
        user_input: request.user_input,
        session_id: request.session_id ?? ctx.sessionId,
        user_key: memUserId,
        agent_name: agentName,
        system_prompt: FDE_ASSISTANT_PROMPT + contextBlock,
        memory: { agent_id: "fde-assistant", user_id: memUserId, limit: 4 },
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
      detail: "fde-assistant ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/fde-assistant",
  layer: LayerId.Persona,
  description: "角色人格层：FDE 数字员工（TiMEM FDE 工作台开放问答）",
  version: "1.0.0",
  provides: [fdeAssistantService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
};
