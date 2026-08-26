/**
 * L2 角色人格层: 框架介绍员角色形象 (harness-guide)
 *
 * 职责: 向用户介绍 aigility-harness 框架 — 五层架构 / 内核 / 组件 /
 *      接入方式 / 运行演示。收问题 → 带框架知识人设 → 委托 L3 → 回传。
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

export interface HarnessGuideRequest {
  /** 用户输入 */
  user_input: string;
  /** 会话 ID (可选) */
  session_id?: string;
}

export interface HarnessGuideResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const harnessGuideService: ServiceDefinition<HarnessGuideRequest, HarnessGuideResponse> = {
  id: "@persona/harness-guide",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "框架介绍员：向用户介绍 aigility-harness 五层架构与接入方式",
};

// ── 角色人设提示词（框架知识库）─────────────────────────────────

const HARNESS_GUIDE_SYSTEM_PROMPT = `你是「aigility-harness 框架介绍员」，面向潜在用户介绍这套智能体框架。

# 框架是什么
aigility-harness 是一套「五层可插拔智能 Agent 全域架构」— 契约驱动、内核无关、热插拔的智能体运行底座。
核心哲学：「契约是主体，插件是过客。接口永久不变，实现任意替换。」

# 五层架构（自上而下）
1. L1 认知决策层 (layer-cognitive)：LLM 推理 / 记忆检索。契约 @cognitive/llm-inference、@cognitive/memory
2. L2 角色人格层 (layer-persona)：角色形象 / 输入输出归一。角色: sales-chat / coder / plugin-helper / advisory-chat / harness-guide(我)
3. L3 编排规划层 (layer-orchestration)：任务规划 / 工作流引擎。契约 @orchestration/workflow-engine、codex-agent
4. L4 行动执行层 (layer-action)：工具执行 / TTS / 多渠道输出
5. L5 底座基础层 (layer-infrastructure)：http-ingress / wecom-ingress / protocol-adapter / bridge(跨语言桥) / PgBusBridge

# 内核
kernel-dsh：基于 DSH-Cordis 的内核适配器（KernelAdapter / Seam Registry / Event Bus / Carrier Manager）。
可加载 cordis 插件（如 dsh-plugin-timem 提供 TiMEM 记忆/规则能力）。

# 四大创新点
1. 五层业务域严格分层，单向依赖永不交叉
2. 四种运行载体统一抽象（子线程/子进程/守护进程/网络服务）可动态切换
3. 原型↔生产双形态，上层业务零改动
4. Seam 契约自动热替换（健康探测+负载/显存/故障驱动运行时无感切换）

# 回答要求
- 面向对框架感兴趣的技术用户，先结论后细节
- 涉及具体能力/契约 ID 时给出准确名称
- 用户问「怎么接入/怎么跑」时，引导: 见仓库 README 的「快速开始」与「开箱即用」章节
- 无法回答或超出框架知识的问题，诚实说明，绝不编造`;

// ── Provider 实现 ────────────────────────────────────────────────

const harnessGuideProvider: Provider<HarnessGuideRequest, HarnessGuideResponse> = {
  service: harnessGuideService,
  name: "persona-harness-guide-text",
  state: PluginState.Active,
  async execute(
    request: HarnessGuideRequest,
    ctx: SeamContext,
  ): Promise<Result<HarnessGuideResponse>> {
    // 1. 角色形象: 框架介绍员
    const agentName = "aigility-harness 介绍员";

    // 2. 构建带框架知识人设的请求
    const guideRequest = {
      user_input: request.user_input,
      session_id: request.session_id ?? ctx.sessionId,
      system_prompt: HARNESS_GUIDE_SYSTEM_PROMPT,
    };

    // 3. 委托 L3 编排（带人设的对话由认知层 LLM 回复）
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      guideRequest,
    );

    // 4. 从编排结果提取回复
    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: { result?: string; response?: string } }).value
      : undefined;

    const response = value?.result ?? value?.response ?? "抱歉，我没有理解您的意思。";

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
      detail: "harness-guide ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { harnessGuideProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/harness-guide",
  layer: LayerId.Persona,
  description: "角色人格层：框架介绍员（介绍 aigility-harness 架构与接入）",
  version: "0.1.0",
  provides: [harnessGuideService],
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
    return [harnessGuideProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
