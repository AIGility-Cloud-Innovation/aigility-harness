/**
 * L3 感知交互层: 编码助手角色形象 (coder)
 *
 * 编码能力的人格化入口——角色名与实现无关(@persona/coder 不绑定任何
 * 具体编码 Agent)，委托 L4 的 @orchestration/codex-agent 完成真实编码:
 *   收"帮我写个 X / 修个 bug" → 人设引导 → 委托 codex-agent(规划+spawn)
 *   → 同一角色反馈结果(代码/改动/计划)
 *
 * 设计要点:
 *   - 角色名永不含实现名(codex/claude/opencode), 换 L4 Provider 零改动
 *   - 角色知识的「载体」: 系统提示词在本角色内构建, 随请求下发
 *   - 不关心编码怎么执行: 那是 codex-agent (L4) 的事
 *   - 认知层供能: 由 http-ingress 的 dev 链路暴露的兼容网关统一供模型
 */

import { llmInferenceRef,
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  LlmInferenceRequest,
  LlmInferenceResponse,
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface CoderRequest {
  /** 用户输入 (如"帮我写个排序算法") */
  user_input: string;
  /** 可选: 工作目录 (默认调用方 cwd) */
  cwd?: string;
  /** 可选: 会话 ID */
  session_id?: string;
  /** 编码驱动 (codex / zcode / claude) */
  driver?: string;
  /** 工作模式: consult=咨询(默认,不改代码) / edit=编辑(真实修改代码) */
  mode?: 'consult' | 'edit';
  /** 会话历史 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface CoderResponse {
  /** 角色反馈文字 (结果/计划/摘要) */
  response: string;
  /** 编码执行的原始结果 (codex-agent 返回) */
  raw?: unknown;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
  /** 本次工作模式 */
  mode?: 'consult' | 'edit';
  /** true = 降级回复 */
  degraded?: boolean;
}

export const coderService: ServiceDefinition<CoderRequest, CoderResponse> = {
  id: "@persona/coder",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "编码助手角色形象：收编码任务 → 委托编排层编码 Agent → 同角色反馈代码/改动",
};

/** 委托的 L4 编码 Agent (实现无关; 换 claude-code/opencode 只改这一处) */
export const codexAgentRef: CapabilityRef = {
  id: "@orchestration/codex-agent",
  versionRange: "^1.0.0",
};

// ── 角色人设提示词 ────────────────────────────────────────────────

const CODER_SYSTEM_PROMPT = `你是「编码助手」，一位资深编码工程师。

你帮助用户完成编码任务，包括：
1. 新功能实现: 根据需求描述编写代码
2. 缺陷修复: 分析错误信息并给出修复方案
3. 代码审查与改进: 重构、优化、可读性建议
4. 技术咨询: 架构选型、API 用法、调试技巧

工作方式:
- 先理解需求, 必要时确认关键细节 (语言/框架/约束)
- 给出实现计划, 再驱动编码 Agent 执行
- 反馈时先给结论 (做了什么/改了什么), 再给可操作的下一步

回答要求:
- 简洁、面向开发者, 代码片段用代码块
- 失败时如实说明失败原因, 不编造成功结果
- 涉及外部依赖/环境问题时说明前提条件`;

// ── Provider 实现 ────────────────────────────────────────────────

const coderProvider: Provider<CoderRequest, CoderResponse> = {
  service: coderService,
  name: "persona-coder-text",
  state: PluginState.Active,
  async execute(
    request: CoderRequest,
    ctx: SeamContext,
  ): Promise<Result<CoderResponse>> {
    // 1. 角色形象: 编码教练 (教学模式, 只教不改)
    const agentName = "编码教练";

    // 2. 汇聚教学素材: 实时扫描插件/包 + 可选讲解目标应用
    const scan = await ctx.call(
      { id: "@orchestration/plugin-install", versionRange: "^1.0.0" },
      { user_input: request.user_input, session_id: request.session_id ?? ctx.sessionId },
    );
    const scanText = (scan as { ok: boolean; value?: { result?: string; available?: string[] } }).ok
      ? [
          "实时扫描: " + ((scan as { value?: { result?: string } }).value?.result ?? ""),
          "可用插件/包: " + ((scan as { value?: { available?: string[] } }).value?.available ?? []).join(", "),
        ].join("\n")
      : "(扫描不可用)";

    // 3. 教学系统提示词
    const teachPrompt = [
      "你是「编码教练」, 教学模式: 只讲解, 绝不修改任何代码文件。",
      "职责: 教用户理解本 harness 的架构与使用方法 —— 五层架构(底座/认知/感知/编排)、应用大厅、编码工作台、插件体系、以及各演示应用的实现思路。",
      "用户问某个应用怎么实现/怎么用: 给出结构讲解与关键实现要点(可用伪代码/片段示意), 但不落盘。",
      "用户想让 AI 真实改代码: 引导他去「网页应用生成器」或编码工作台的编辑模式。",
      "回答基于以下实时扫描信息, 结论先行, 教学语气:",
      scanText,
    ].join("\n");

    // 4. 委托认知层生成教学内容
    const llm = await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
      llmInferenceRef,
      {
        model: process.env.LLM_MODEL ?? "glm-4.6",
        messages: [
          { role: "system", content: teachPrompt },
          ...(request.history?.length ? request.history.map((m) => ({ role: m.role, content: m.content })) : []),
          { role: "user", content: request.user_input },
        ],
        temperature: 0.5,
      },
    ) as Result<LlmInferenceResponse>;
    const text = llm.ok ? (llm.value?.text || "（空回复）") : `教学服务暂不可用: ${llm.error}`;

    return ok({
      response: text,
      agent_name: agentName,
      mode: "consult",
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(llm.ok ? {} : { degraded: true }),
    });

  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "coder ready (委托 @orchestration/codex-agent)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { coderProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/coder",
  layer: LayerId.Persona,
  description: "感知层：编码助手角色形象（实现无关，委托 L4 编码 Agent）",
  version: "0.1.0",
  provides: [coderService],
  consumes: [codexAgentRef],
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
    return [coderProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};