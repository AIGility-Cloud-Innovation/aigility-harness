/**
 * 智悦平台数字员工（@persona/aigility-agent）—— 示例本地插件（不改框架包）
 *
 * 智能体工厂发布的技能与平台默认管家共用这一个 persona 入口：
 *   - payload.skill_id 命中 skill-registry → 加载该技能的 Prompt/描述/边界作为 system prompt
 *   - 未携带 → 平台默认管家（介绍智悦平台与 aigility-harness 的封装关系）
 * 与 fde-assistant 同构：角色域只负责 system prompt 装配，
 * TiMEM 记忆召回/沉淀作为流内标准节点下沉编排域，按技能隔离（agent_id=aigility-skill-<id>）。
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
  LayerPlugin,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

import { getSkill, bumpSkillUsage } from "./skill-registry.js";
import { SITE_IMPROVER_SKILL_ID, improverTurn } from "./site-improver.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface AigilityAgentRequest {
  /** 用户的提问 */
  user_input: string;
  /** 数字员工技能 id（智能体工厂发布，缺省走平台默认管家） */
  skill_id?: string;
  /** 会话 ID (可选, 前端维护) */
  session_id?: string;
  /** 用户标识 (TiMEM 记忆按此隔离) */
  user_key?: string;
  /** 会话历史 (前端维护, 透传编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 请求级 LLM 上游覆盖 (缺省走全局) */
  llm?: {
    url?: string;
    key?: string;
    model?: string;
  };
}

export interface AigilityAgentResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份（技能名或平台管家） */
  agent_name: string;
  /** 本次生效的技能 id */
  skill_id?: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
  /** true = LLM 不可用, 本次回复来自降级 stub */
  degraded?: boolean;
  /** true = 本次对话落了任务板（平台改进专员技能） */
  filed?: boolean;
  task_id?: string;
}

export const aigilityAgentService: ServiceDefinition<AigilityAgentRequest, AigilityAgentResponse> = {
  id: "@persona/aigility-agent",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "智悦平台数字员工：按 skill_id 加载智能体工厂发布的技能人设（缺省平台管家），记忆按技能隔离",
};

// ── 平台默认管家提示词 ───────────────────────────────────────────

const BUTLER_PROMPT = [
  "你是「Aigility 平台管家」, 服务于 Aigility 智悦智能平台（英文名 Aigility, 中文名「智悦」）—— FDE 自用的数字员工智能体平台, 把 aigility-harness 引擎封装为可交付产品。",
  "平台把 aigility-harness 五域引擎（角色人格/编排规划/行动执行/认知算力/底座基础设施）封装为可交付的数字员工产品：",
  "智能体工厂创建与发布数字员工、市场与应用中心上架复用、TiMEM 空间沉淀记忆与规则。",
  "",
  "## 回答要求",
  "- 用简体中文, 结论先行, 专业简洁。",
  "- 你熟悉平台的用法（智能体工厂五步向导、对话工作台、TiMEM 空间、模型与工具管理），也熟悉 aigility-harness 的五域架构与 Seam 契约。",
  "- 涉及具体企业数据（台账/图谱/告警）时如实说明「该技能尚未挂载数据上下文」，不编造。",
].join("\n");

// ── Provider 实现 ────────────────────────────────────────────────

const providerName = "persona-aigility-agent-text";

export const aigilityAgentProvider: Provider<AigilityAgentRequest, AigilityAgentResponse> = {
  service: aigilityAgentService,
  name: providerName,
  state: PluginState.Active,
  async execute(
    request: AigilityAgentRequest,
    ctx: SeamContext,
  ): Promise<Result<AigilityAgentResponse>> {
    const skill = request.skill_id ? getSkill(request.skill_id) : undefined;
    bumpSkillUsage(skill?.id ?? "butler");
    const agentName = skill ? skill.name : "Aigility 平台管家";
    const memAgentId = skill ? `aigility-skill-${skill.id}` : "aigility-butler";
    const memUserId = request.user_key ?? "fde-local";

    // 平台改进专员技能：不走通用 Prompt 装配，委托 improverTurn（聊需求 → 落任务板 → 派编码代理）
    if (skill?.id === SITE_IMPROVER_SKILL_ID) {
      const turn = await improverTurn(ctx, {
        user_input: request.user_input,
        user_key: memUserId,
        session_id: request.session_id ?? ctx.sessionId,
        ...(request.history?.length ? { history: request.history } : {}),
      });
      return ok({
        response: turn.response,
        agent_name: agentName,
        skill_id: skill.id,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
        ...(turn.filed ? { filed: true, task_id: turn.task_id } : {}),
      });
    }

    // 技能人设：工厂 Prompt 为主体 + 描述/标签补充边界
    const systemPrompt = skill
      ? [
          skill.prompt.trim(),
          "",
          `## 角色设定（智能体工厂发布）`,
          `- 数字员工名称：${skill.name}（分类：${skill.category}）`,
          `- 能力定位：${skill.description}`,
          ...(skill.tags.length ? [`- 能力标签：${skill.tags.join("、")}`] : []),
          ...(skill.knowledge.length ? [`- 挂载知识库：${skill.knowledge.join("、")}（引用时注明来源知识库）`] : []),
          ...(skill.tools.length ? [`- 声明工具：${skill.tools.join("、")}（当前为展示配置, 未接真实执行, 需要系统操作时告知用户到对应页面人工处理）`] : []),
          "",
          "## 行为边界",
          "- 用简体中文回答; 知识库与记忆中没有依据的内容如实说明, 不编造数据。",
          "- 写操作（派单/发文/停机等）不由你执行, 提示用户在对应页面人工确认。",
        ].join("\n")
      : BUTLER_PROMPT;

    // 委托 L4 编排（记忆召回 → LLM → 沉淀 三段流内编排, 尽力而为）
    const result = (await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      {
        user_input: request.user_input,
        session_id: request.session_id ?? ctx.sessionId,
        user_key: memUserId,
        agent_name: agentName,
        system_prompt: systemPrompt,
        memory: { agent_id: memAgentId, user_id: memUserId, limit: 4 },
        ...(request.llm ? { llm: request.llm } : {}),
        ...(request.history?.length ? { history: request.history } : {}),
      },
    )) as { ok: boolean; value?: { result?: string; response?: string; degraded?: boolean } };

    const wfValue = result.value;
    const response = result.ok
      ? (wfValue?.result ?? wfValue?.response ?? "抱歉，我没有理解您的意思。")
      : "抱歉，数字员工暂时无法响应，请稍后重试。";

    return ok({
      response,
      agent_name: agentName,
      ...(skill ? { skill_id: skill.id } : {}),
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(wfValue?.degraded ? { degraded: true } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "aigility-agent ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单（示例本地 LayerPlugin, 随主装配注入 bootstrap） ──────

export const manifest: PluginManifest = {
  name: "@persona/aigility-agent",
  layer: LayerId.Persona,
  description: "角色人格层：智悦平台数字员工（智能体工厂发布技能的对话入口）",
  version: "1.0.0",
  provides: [aigilityAgentService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
};

export const aigilityAgentPlugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [aigilityAgentProvider];
  },
  getState(): PluginState {
    return PluginState.Active;
  },
};
