/**
 * L3 感知交互层: 插件安装助手角色形象 (plugin-helper)
 *
 * 开箱即用引导角色：用户问「怎么加个插件 / RAG / 记忆」时，由本角色
 * 承接，委托 L4 的 plugin-install 工作流完成：
 *   扫描插件目录 / py-plugins.json → 契约校验（provides/consumes）→ 输出装配指引
 *
 * 设计要点（与 advisory-chat 同款骨架）:
 *   - 角色知识的「载体」: 系统提示词在本角色内构建, 随请求下发
 *   - 不关心插件怎么装: 那是 plugin-install 工作流 (L4) 的事
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

export interface PluginHelperRequest {
  /** 用户输入 (如"帮我加个 RAG 插件") */
  user_input: string;
  /** 可选: 会话 ID */
  session_id?: string;
}

export interface PluginHelperResponse {
  /** 引导回复文字 */
  response: string;
  /** 可用插件清单 (工作流返回) */
  available?: string[];
  /** 推荐接入方式 (py-plugins.json / TS 插件 / 工作流) */
  suggested_path?: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const pluginHelperService: ServiceDefinition<PluginHelperRequest, PluginHelperResponse> = {
  id: "@persona/plugin-helper",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "插件安装助手角色形象：收安装问题 → 委托编排层 plugin-install 工作流 → 回引导步骤",
};

// ── 角色人设提示词 ────────────────────────────────────────────────

const PLUGIN_HELPER_SYSTEM_PROMPT = `你是「插件安装助手」，aigility-harness 框架的开箱即用引导角色。

你帮助用户安装/接入新插件能力，包括：
1. TS 原生插件: 在 packages/ 下新建 LayerPlugin, 声明 provides/consumes 契约
2. Python 能力插件: 在 config/py-plugins.json 声明式接入 (aigility.rag / aigility.memory 等)
3. 编排工作流: 通过 workflow-config.yaml 声明节点和边 (function_node / llm_node / capability_node)

回答要求:
- 先给结论 (插件能否装、走哪条接入路径), 再给步骤
- 涉及契约校验 (provides 能力是否有对应 consumers / 缺依赖) 时如实说明
- 无法回答的问题, 诚实说"超出我的安装知识", 绝不编造插件名
- 回答简洁、面向开发者`;

// ── Provider 实现 ────────────────────────────────────────────────

const pluginHelperProvider: Provider<PluginHelperRequest, PluginHelperResponse> = {
  service: pluginHelperService,
  name: "persona-plugin-helper-text",
  state: PluginState.Active,
  async execute(
    request: PluginHelperRequest,
    ctx: SeamContext,
  ): Promise<Result<PluginHelperResponse>> {
    // 1. 角色形象: 插件安装助手
    const agentName = "插件安装助手";

    // 2. 构建带角色知识的请求
    const installRequest = {
      user_input: request.user_input,
      session_id: request.session_id ?? ctx.sessionId,
      system_prompt: PLUGIN_HELPER_SYSTEM_PROMPT,
    };

    // 3. 委托 L4 编排 (plugin-install 工作流: 扫描 → 契约校验 → 指引)
    const result = await ctx.call(
      { id: "@orchestration/plugin-install", versionRange: "^1.0.0" },
      installRequest,
    );

    // 4. 从编排结果提取回复
    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: { result?: string; response?: string; available?: string[]; suggested_path?: string } }).value
      : undefined;

    const response = value?.result ?? value?.response ?? "抱歉，我没有理解您的意思。";

    return ok({
      response,
      ...(value?.available ? { available: value.available } : {}),
      ...(value?.suggested_path ? { suggested_path: value.suggested_path } : {}),
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "plugin-helper ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { pluginHelperProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/plugin-helper",
  layer: LayerId.Persona,
  description: "感知层：插件安装助手角色形象（开箱即用引导）",
  version: "0.1.0",
  provides: [pluginHelperService],
  consumes: [{ id: "@orchestration/plugin-install", versionRange: "^1.0.0" }],
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
    return [pluginHelperProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};