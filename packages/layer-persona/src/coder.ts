/**
 * L2 感知交互层: 编码助手角色形象 (coder)
 *
 * 编码能力的人格化入口——角色名与实现无关(@persona/coder 不绑定任何
 * 具体编码 Agent)，委托 L3 的 @orchestration/codex-agent 完成真实编码:
 *   收"帮我写个 X / 修个 bug" → 人设引导 → 委托 codex-agent(规划+spawn)
 *   → 同一角色反馈结果(代码/改动/计划)
 *
 * 设计要点:
 *   - 角色名永不含实现名(codex/claude/opencode), 换 L3 Provider 零改动
 *   - 角色知识的「载体」: 系统提示词在本角色内构建, 随请求下发
 *   - 不关心编码怎么执行: 那是 codex-agent (L3) 的事
 *   - 认知层供能: 由 http-ingress 的 dev 链路暴露的兼容网关统一供模型
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
}

export const coderService: ServiceDefinition<CoderRequest, CoderResponse> = {
  id: "@persona/coder",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "编码助手角色形象：收编码任务 → 委托编排层编码 Agent → 同角色反馈代码/改动",
};

/** 委托的 L3 编码 Agent (实现无关; 换 claude-code/opencode 只改这一处) */
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
    // 1. 角色形象: 编码助手
    const agentName = "编码助手";

    // 2. 构建带角色知识的编码任务 (委托 L3 codex-agent)
    const task = {
      prompt: `${CODER_SYSTEM_PROMPT}\n\n用户任务:\n${request.user_input}`,
      ...(request.cwd ? { cwd: request.cwd } : {}),
    };

    // 3. 委托 L3: codex-agent 负责 规划(经认知层 LLM) + spawn Codex 执行
    const result = await ctx.call(codexAgentRef, task);

    // 4. 由同一角色形象反馈
    if (!result.ok) {
      return ok({
        response: `编码任务未完成：${result.error}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }
    const raw = result.value as { text?: string; plan?: string };
    const response =
      raw?.text && raw.text.length > 0
        ? raw.text
        : "编码任务已完成，但未返回可展示的文本结果。";

    return ok({
      response,
      ...(result.value ? { raw: result.value } : {}),
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
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
  description: "感知层：编码助手角色形象（实现无关，委托 L3 编码 Agent）",
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