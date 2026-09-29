/**
 * L4 编排规划层 — @harness/workflow-run 能力的消费端接线。
 *
 * 大规模多代理编排（脚本 fan-out 子代理）经 seam 调用家族实现：
 *   layer-orchestration（本文件，只认 core 契约）
 *     → ctx.call(dshWorkflowRunRef, WorkflowRunRequest)
 *     → seam registry → dsh-interop 的 createDshWorkflowRunProvider
 *     → 官方 dsh workflow 引擎。
 *
 * 本层不 import 任何 <family>-interop 包——换 harness 家族时本文件零改动。
 */

import type {
  CapabilityRef,
  Result,
  SeamContext,
  WorkflowRunOutcome,
  WorkflowRunRequest,
} from "@aigility-harness/core";

/** 编排能力引用（声明消费；与 dsh-interop 的 dshWorkflowRunService.id 对齐）。 */
export const workflowRunRef: CapabilityRef = {
  id: "@harness/workflow-run",
  versionRange: "^1.0.0",
};

/**
 * 经 seam 跑一次 workflow 编排。失败时返回 err（含缺配置/引擎错误信息），
 * 成功时 value 为 WorkflowRunOutcome（result 字段是脚本最终 JSON 返回值）。
 */
export async function runWorkflowViaSeam(
  ctx: SeamContext,
  request: WorkflowRunRequest,
): Promise<Result<WorkflowRunOutcome>> {
  return (await ctx.call<WorkflowRunRequest, WorkflowRunOutcome>(
    workflowRunRef,
    request,
  )) as Result<WorkflowRunOutcome>;
}
