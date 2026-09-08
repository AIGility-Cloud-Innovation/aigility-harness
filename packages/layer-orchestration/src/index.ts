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
  codexAgentService,
  codexAgentProvider,
  type CodexAgentRequest,
  type CodexAgentResponse,
  type CodexAgentItem,
  type CodexAgentTurnUsage,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codex-agent.js";

export { codexAgentService, codexAgentProvider };
export type {
  CodexAgentRequest,
  CodexAgentResponse,
  CodexAgentItem,
  CodexAgentTurnUsage,
  CodexApprovalPolicy,
  CodexSandboxMode,
};

import {
  timemTaskService,
  timemTaskProvider,
  enableTimemTask,
} from "./timem-task.js";
export { timemTaskService, timemTaskProvider, enableTimemTask };
export type {
  TimemTaskRequest,
  TimemTaskResponse,
} from "./timem-task.js";

import {
  zcodeAgentService,
  zcodeAgentProvider,
  zcodeAgentRef,
} from "./zcode-agent.js";
export { zcodeAgentService, zcodeAgentProvider, zcodeAgentRef };
export type {
  ZcodeAgentRequest,
  ZcodeAgentResponse,
} from "./zcode-agent.js";

import {
  claudeAgentService,
  claudeAgentProvider,
  claudeAgentRef,
} from "./claude-agent.js";
export { claudeAgentService, claudeAgentProvider, claudeAgentRef };
export type {
  ClaudeAgentRequest,
  ClaudeAgentResponse,
} from "./claude-agent.js";

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
  agent_name?: string;
  /** 角色专属系统提示词 (persona 注入) */
  system_prompt?: string;
  /** 会话历史 (来自调用方/前端; 未提供时用服务端 session 记忆兜底) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
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
    const messages: LlmInferenceRequest["messages"] = [
      {
        role: "system",
        content:
          request.system_prompt ||
          `你是「${request.agent_name ?? "智能助理"}」。请用简体中文简洁、专业地回复用户。`,
      },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: request.user_input },
    ];
    console.log('[workflow-engine] system_prompt len:', request.system_prompt?.length ?? 0, '| agent:', request.agent_name);
    let degraded = false;
    let replyText = "";
    try {
      const llmRes = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
        llmInferenceRef,
        {
          model: process.env.LLM_MODEL ?? "glm-4.6",
          messages,
          temperature: 0.7,
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
  description: "编排规划层：任务规划占位 + 工作流引擎占位 + 插件安装工作流 + Codex 编码代理，消费认知层 LLM",
  version: "0.2.0",
  provides: [taskPlanningService, workflowEngineService, pluginInstallService, codexAgentService, zcodeAgentService, claudeAgentService, guidedDesignService],
  consumes: [llmInferenceRef],
  preferredCarrier: CarrierKind.Thread,
  dependsOn: ["@cognitive/llm-inference"],
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
    return [taskPlanningProvider, workflowEngineProvider, pluginInstallProvider, codexAgentProvider, zcodeAgentProvider, claudeAgentProvider, guidedDesignProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
// 沙箱快照备份工具（编码代理改文件前自动快照；版本回滚 UI 复用）
export { backupHtmlFiles } from "./sandbox-backup.js";
