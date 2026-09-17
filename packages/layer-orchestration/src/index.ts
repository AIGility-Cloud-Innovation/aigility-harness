/**
 * @aigility-harness/layer-orchestration — 编排规划层
 *
 * 提供任务规划占位能力（@orchestration/task-planning）。
 * 声明消费认知层的 @cognitive/llm-inference，用于基于 LLM 输出规划步骤。
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
  LlmInferenceRequest,
  LlmInferenceResponse,
} from "@aigility-harness/core";

import {
  timemProjectTaskService,
  timemProjectTaskProvider,
  enableTimemProjectTask,
} from "./timem-project-task.js";
export { timemProjectTaskService, timemProjectTaskProvider, enableTimemProjectTask };
export type {
  TimemProjectTaskRequest,
  TimemProjectTaskResponse,
} from "./timem-project-task.js";

export { RequirementStore } from "./requirement-store.js";
export type {
  SessionPhase,
  SessionState,
  Requirement,
  RequirementStatus,
  Consolidation,
  ConsolidationItem,
} from "./requirement-store.js";
export {
  CONSOLIDATION_SYSTEM_PROMPT,
  parseConsolidation,
  topoSort,
  buildConsolidation,
  renderConsolidation,
} from "./consolidation.js";

import {
  pluginInstallService,
  pluginInstallProvider,
} from "./plugin-install.js";
export { pluginInstallService, pluginInstallProvider };
export type {
  PluginInstallRequest,
  PluginInstallResponse,
} from "./plugin-install.js";

import {
  guidedDesignService,
  guidedDesignProvider,
} from "./guided-design.js";
export { guidedDesignService, guidedDesignProvider };
export type {
  GuidedDesignRequest,
  GuidedDesignResponse,
  GuidedDesignSessionState,
  DesignPhase,
} from "./guided-design.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface TaskPlanningRequest {
  /** 规划目标 */
  goal: string;
  /** 可选上下文 */
  context?: string;
}

export interface TaskPlanningResponse {
  steps: string[];
  goal: string;
  plannedBy: string;
}

export const taskPlanningService: ServiceDefinition<
  TaskPlanningRequest,
  TaskPlanningResponse
> = {
  id: "@orchestration/task-planning",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "任务规划能力（原型占位，返回确定性步骤）",
};

// 编排层消费认知层的 LLM 推理能力
export const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};

// ── WorkflowEngine 占位 Provider（@orchestration/workflow-engine）──
//
// 契约：接收感知层角色形象（sales-chat）委托的 ChatRequest，产出最终回复。
// 生产实现由 py-bridge 热切换 → aigility.workflow.WorkflowEngine（YAML → LangGraph）。
// 此处为确定性 stub，让纯 TS 原型链路（L3 → L4 → 回复）无需 Python 也能跑通。

export interface WorkflowEngineRequest {
  user_input: string;
  merchant_id?: string;
  customer_id?: string;
  session_id?: string;
  /** 归因身份（平台账号/角色 user_key），透传给 LLM 计量按用户聚合 */
  user_key?: string;
  agent_name?: string;
  /** 角色专属系统提示词 (persona 注入) */
  system_prompt?: string;
  /** 会话历史 (来自调用方/前端; 未提供时用服务端 session 记忆兜底) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 流内记忆节点 (可选): 传入后启用 召回→LLM→沉淀 三段编排, 按用户+agent 隔离 */
  memory?: {
    /** 记忆隔离的 agent 标识 (如 banban-assist / repair-chat) */
    agent_id: string;
    /** 记忆归属用户 (通常为登录邮箱) */
    user_id: string;
    /** 召回条数 (默认 4) */
    limit?: number;
  };
  /** 请求级 LLM 上游覆盖 (可选): 应用自带 LLM 配置时传入, 缺省走 env 全局 */
  llm?: {
    url?: string;
    key?: string;
    model?: string;
  };
}

export interface WorkflowEngineResponse {
  result: string;
  workflow: string;
  session_id: string;
  /** true = LLM 不可用, 本次回复来自降级 stub */
  degraded?: boolean;
}

// 服务端会话记忆: session_id → 最近消息 (上限 20 条, 兜底用;
// 调用方显式传 history 时以传入为准)
const SESSION_MEMORY = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
const MAX_SESSION_MSGS = 20;

function loadHistory(sessionId: string | undefined): Array<{ role: "user" | "assistant"; content: string }> {
  if (!sessionId) return [];
  return SESSION_MEMORY.get(sessionId) ?? [];
}

function saveHistory(
  sessionId: string | undefined,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): void {
  if (!sessionId) return;
  SESSION_MEMORY.set(sessionId, history.slice(-MAX_SESSION_MSGS));
}

export const workflowEngineService: ServiceDefinition<
  WorkflowEngineRequest,
  WorkflowEngineResponse
> = {
  id: "@orchestration/workflow-engine",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "工作流引擎（原型占位，生产由 py-bridge 热切换为 LangGraph）",
};

const workflowEngineProvider: Provider<
  WorkflowEngineRequest,
  WorkflowEngineResponse
> = {
  service: workflowEngineService,
  name: "orchestration-workflow-engine-stub",
  state: PluginState.Active,
  async execute(
    request: WorkflowEngineRequest,
    ctx: SeamContext,
  ): Promise<Result<WorkflowEngineResponse>> {
    // 原型执行：委托认知层 LLM 推理（py-bridge 接入后热切换为 LangGraph）。
    // LLM 不可用时降级为确定性 stub 回复（degraded=true 显式标记），保证链路不断。
    const sessionId = request.session_id;
    const history = request.history?.length ? request.history.slice(-MAX_SESSION_MSGS) : loadHistory(sessionId);
    // ── 记忆召回节点 (流内标准节点, 尽力而为): 命中则注入系统提示词, 失败静默降级 ──
    let systemPrompt =
      request.system_prompt ||
      `你是「${request.agent_name ?? "智能助理"}」。请用简体中文简洁、专业地回复用户。`;
    if (request.memory) {
      try {
        const memRes = (await ctx.call<{ query: string; user_id: string; agent_id: string; limit: number },
          { ok?: boolean; results?: Array<{ content: string }>; error?: string }>(
          { id: "@action/timem-memory", versionRange: "^1.0.0" },
          {
            query: request.user_input.slice(0, 200),
            user_id: request.memory.user_id,
            agent_id: request.memory.agent_id,
            limit: request.memory.limit ?? 4,
          },
        )) as Result<{ ok?: boolean; results?: Array<{ content: string }>; error?: string }>;
        const memValue = memRes.ok ? memRes.value : undefined;
        const items = memValue?.ok ? (memValue.results ?? []).map((r) => r.content).filter(Boolean) : [];
        if (items.length > 0) {
          systemPrompt += `\n\n【你与这位用户的历史相关记忆】(可参考; 与当前问题相关时自然提及, 不确定时询问)\n${items
            .map((c, i) => `${i + 1}. ${c}`)
            .join("\n")}`;
        }
        console.log(`[workflow-engine] memory recall ${items.length} items for ${request.memory.user_id}@${request.memory.agent_id}${memValue?.ok ? "" : ` (timem: ${memValue?.error ?? "unavailable"})`}`);
      } catch (e) {
        console.log(`[workflow-engine] memory recall skipped: ${String((e as Error)?.message ?? e)}`);
      }
    }

    const messages: LlmInferenceRequest["messages"] = [
      {
        role: "system",
        content: systemPrompt,
      },      // 角色归一化: 旧版前端曾存 role:"bot", 智谱等上游对非法角色报 1214 ——
      // 统一收敛为 user/assistant, 内容强转字符串, 脏历史不炸链路
      ...history
        .filter((m) => m && typeof m.content === "string" && m.content.trim())
        .map((m) => ({
          role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: m.content,
        })),
      { role: "user" as const, content: request.user_input },
    ];
    console.log('[workflow-engine] system_prompt len:', request.system_prompt?.length ?? 0, '| agent:', request.agent_name);
    let degraded = false;
    let replyText = "";
    try {
      const llmRes = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
        llmInferenceRef,
        {
          model: request.llm?.model || process.env.LLM_MODEL || "glm-4.6",
          messages,
          temperature: 0.7,
          userId: request.user_key ?? request.customer_id ?? request.merchant_id,
          ...(request.llm?.url || request.llm?.key
            ? { upstream: { url: request.llm?.url ?? "", key: request.llm?.key ?? "" } }
            : {}),
        },
      )) as Result<LlmInferenceResponse>;
      if (llmRes.ok && llmRes.value?.text) {
        replyText = llmRes.value.text;
      } else {
        degraded = true;
        console.error("[workflow-engine] LLM 调用失败，降级 stub:", llmRes.ok ? "空回复" : llmRes.error);
      }
    } catch (e) {
      degraded = true;
      console.error("[workflow-engine] LLM 调用异常，降级 stub:", e);
    }
    // 成功与否都更新会话记忆 (降级回复也入历史, 保持上下文连续)
    saveHistory(sessionId, [
      ...history,
      { role: "user", content: request.user_input },
      { role: "assistant", content: replyText || "(degraded)" },
    ]);

    // ── 记忆沉淀节点 (流内标准节点, 尽力而为): 降级回复不写入, 避免污染长期记忆 ──
    if (!degraded && request.memory) {
      try {
        await ctx.call<{ content: string; user_id: string; agent_id: string }, { ok?: boolean; error?: string }>(
          { id: "@action/timem-memory-write", versionRange: "^1.0.0" },
          {
            content: `问答 (${new Date().toISOString().slice(0, 10)}): 用户问「${request.user_input.slice(0, 150)}」; 答复要点: ${replyText.slice(0, 200)}`,
            user_id: request.memory.user_id,
            agent_id: request.memory.agent_id,
          },
        );
        console.log(`[workflow-engine] memory persisted for ${request.memory.user_id}@${request.memory.agent_id}`);
      } catch (e) {
        console.log(`[workflow-engine] memory persist skipped: ${String((e as Error)?.message ?? e)}`);
      }
    }
    if (!degraded) {
      return ok({
        result: replyText,
        workflow: "stub-workflow@0.1.0",
        session_id: sessionId ?? "unknown",
      });
    }
    return ok({
      result: `【服务降级】LLM 暂不可用，这是占位回复。请稍后重试或检查 LLM 服务配置。`,
      workflow: "stub-workflow@0.1.0",
      session_id: sessionId ?? "unknown",
      degraded: true,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub workflow engine ready (py-bridge 接入后热切换为 LangGraph)",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── Provider 实现 ────────────────────────────────────────────────

const taskPlanningProvider: Provider<
  TaskPlanningRequest,
  TaskPlanningResponse
> = {
  service: taskPlanningService,
  name: "orchestration-task-planning-stub",
  state: PluginState.Active,
  async execute(
    request: TaskPlanningRequest,
    _ctx: SeamContext,
  ): Promise<Result<TaskPlanningResponse>> {
    // 占位规划：将目标拆为固定的三步
    const steps = [
      `分析目标：${request.goal}`,
      `生成执行计划${request.context ? `（上下文：${request.context}）` : ""}`,
      `校验并返回步骤`,
    ];
    return ok({
      steps,
      goal: request.goal,
      plannedBy: "stub-planner@0.1.0",
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub task planning ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@orchestration/task-planning",
  layer: LayerId.Orchestration,
  description: "编排规划层：任务规划占位 + 工作流引擎(流内记忆节点) + 插件安装工作流 + Codex 编码代理，消费认知层 LLM 与行动域 TiMEM 记忆",
  version: "0.3.0",
  provides: [taskPlanningService, workflowEngineService, pluginInstallService, guidedDesignService],
  consumes: [llmInferenceRef, { id: "@action/timem-memory", versionRange: "^1.0.0" }, { id: "@action/timem-memory-write", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
  dependsOn: ["@cognitive/llm-inference", "@action/tool-execution"],
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
    return [taskPlanningProvider, workflowEngineProvider, pluginInstallProvider, guidedDesignProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
