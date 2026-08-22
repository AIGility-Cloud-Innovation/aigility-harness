/**
 * @aigility-arch/layer-action — 行动执行工具层
 *
 * 提供工具执行占位能力（@action/tool-execution）。
 * 声明消费编排层的 @orchestration/task-planning。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-arch/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface ToolExecutionRequest {
  /** 工具名称 */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
}

export interface ToolExecutionResponse {
  result: unknown;
  success: boolean;
  executedTool: string;
}

export const toolExecutionService: ServiceDefinition<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  id: "@action/tool-execution",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "工具执行能力（原型占位，返回参数回显）",
};

// 行动层消费编排层的任务规划能力
export const taskPlanningRef: CapabilityRef = {
  id: "@orchestration/task-planning",
  versionRange: "^1.0.0",
};

// ── Provider 实现 ────────────────────────────────────────────────

const toolExecutionProvider: Provider<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  service: toolExecutionService,
  name: "action-tool-execution-stub",
  state: PluginState.Active,
  async execute(
    request: ToolExecutionRequest,
    _ctx: SeamContext,
  ): Promise<Result<ToolExecutionResponse>> {
    // 占位执行：回显工具名与参数
    return ok({
      result: { echoedArgs: request.args },
      success: true,
      executedTool: request.tool,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub tool execution ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/tool-execution",
  layer: LayerId.Action,
  description: "行动执行层：工具执行占位，消费编排层规划",
  version: "0.1.0",
  provides: [toolExecutionService],
  consumes: [taskPlanningRef],
  preferredCarrier: CarrierKind.Subprocess,
  dependsOn: ["@orchestration/task-planning"],
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
    return [toolExecutionProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
