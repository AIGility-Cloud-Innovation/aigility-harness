/**
 * L2 感知交互层: 就业数据顾问角色形象
 *
 * CareerEdu 专属角色: 面向高校就业数据驾驶舱的业务顾问。
 * 职责:
 *   - 持有行业/指标知识 (system prompt 注入给编排层)
 *   - 接收用户自由提问 → 委托 L3 workflow-engine 完成
 *     (意图识别 → 取数 → 生成图表 + 分析文字)
 *   - 由同一角色形象反馈带图表的回复
 *
 * 设计要点:
 *   - 角色知识的「载体」: 系统提示词在 chat-agent 内构建, 随请求下发
 *   - 不关心图表怎么生成: 那是 workflow-engine (LangGraph) 的事
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

export interface AdvisoryChatRequest {
  /** 用户输入 (自由问题, 支持跨维度长问题) */
  user_input: string;
  /** 可选: 会话 ID */
  session_id?: string;
  /** 可选: 用户角色 (学生/就业指导老师/校领导) */
  role?: string;
}

/**
 * 回复载体: 文字 + 结构化图表配置 (前端可直接渲染 ECharts)
 */
export interface AdvisoryChatResponse {
  /** 分析回复文字 */
  response: string;
  /** 图表配置 (可选) */
  chart?: {
    type: string;
    config: Record<string, unknown>;
  };
  /** 命中的数据指标 */
  metric?: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const advisoryChatService: ServiceDefinition<AdvisoryChatRequest, AdvisoryChatResponse> = {
  id: "@advisory/advisory-chat",
  version: "1.0.0",
  layer: LayerId.Perception,
  description: "就业数据顾问角色形象：收问题 → 委托编排层分析 → 回文字+图表",
};

// ── 行业知识提示词 (角色人设) ────────────────────────────────────

const ADVISORY_SYSTEM_PROMPT = `你是「就业数据顾问」, 高校智慧就业平台的数据分析助手。

你擅长回答以下类型的就业数据问题:
1. 整体就业概况 (就业率、毕业生规模)
2. 就业率趋势 (近三年变化、同比环比)
3. 学院排名与竞争力 (各二级学院就业情况)
4. 专业竞争力 (各专业就业表现)
5. 就业岗位分布 (热门岗位、岗位类型占比)
6. 未就业原因分析 (待就业、升学、暂不就业等)
7. 薪酬分布 (起薪区间、平均月薪)
8. 职业资格证书 (持证率、热门证书)
9. 就业满意度 (教育教学评价)
10. 用人单位评价 (招聘方对毕业生的评价维度)

回答要求:
- 先给出明确的结论性回答, 再用数据佐证
- 数据来源于驾驶舱后端接口, 必须客观引用实际数据
- 若问题跨多个维度 (如"就业率+薪酬"), 说明每个维度的情况再综合
- 无法从现有数据回答的问题, 诚实说明数据未覆盖
- 回答要简洁、有逻辑、面向决策者`;

// ── Provider 实现 ────────────────────────────────────────────────

const advisoryChatProvider: Provider<AdvisoryChatRequest, AdvisoryChatResponse> = {
  service: advisoryChatService,
  name: "advisory-chat-text",
  state: PluginState.Active,
  async execute(
    request: AdvisoryChatRequest,
    ctx: SeamContext,
  ): Promise<Result<AdvisoryChatResponse>> {
    // 1. 角色形象: 就业数据顾问
    const agentName = "就业数据顾问";

    // 2. 构建带角色知识的请求
    const chatRequest = {
      user_input: request.user_input,
      session_id: request.session_id ?? ctx.sessionId,
      system_prompt: ADVISORY_SYSTEM_PROMPT,
      role: request.role ?? "default",
    };

    // 3. 委托 L3 编排 (workflow-engine: 意图识别→取数→图表+分析)
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      chatRequest,
    );

    // 4. 从编排结果提取 文字+图表
    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: { result?: string; response?: string; answer?: string; chart?: unknown; metric?: string } }).value
      : undefined;

    const response = value?.answer ?? value?.result ?? value?.response ?? "抱歉，我没有理解您的意思。";
    const chart = (value?.chart && typeof value?.chart === "object")
      ? (value.chart as { type: string; config: Record<string, unknown> })
      : undefined;

    return ok({
      response,
      ...(chart ? { chart } : {}),
      ...(value?.metric ? { metric: value.metric } : {}),
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "advisory-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { advisoryChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@advisory/advisory-chat",
  layer: LayerId.Perception,
  description: "感知层：就业数据顾问角色形象（含行业知识提示词）",
  version: "0.1.0",
  provides: [advisoryChatService],
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
    return [advisoryChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};