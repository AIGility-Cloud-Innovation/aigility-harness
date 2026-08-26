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
  pluginInstallService,
  pluginInstallProvider,
} from "./plugin-install.js";
export { pluginInstallService, pluginInstallProvider };
export type {
  PluginInstallRequest,
  PluginInstallResponse,
} from "./plugin-install.js";

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
// 此处为确定性 stub，让纯 TS 原型链路（L2 → L3 → 回复）无需 Python 也能跑通。

export interface WorkflowEngineRequest {
  user_input: string;
  merchant_id?: string;
  customer_id?: string;
  session_id?: string;
  agent_name?: string;
}

export interface WorkflowEngineResponse {
  result: string;
  workflow: string;
  session_id: string;
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
    _ctx: SeamContext,
  ): Promise<Result<WorkflowEngineResponse>> {
    // 占位执行：确定性回复（不回显用户输入），附带 workflow 标识
    return ok({
      result: `（原型 stub 工作流）已收到您的消息，回复角色「${request.agent_name ?? "客服"}」`,
      workflow: "stub-workflow@0.1.0",
      session_id: request.session_id ?? "unknown",
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
  provides: [taskPlanningService, workflowEngineService, pluginInstallService, codexAgentService],
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
    return [taskPlanningProvider, workflowEngineProvider, pluginInstallProvider, codexAgentProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};