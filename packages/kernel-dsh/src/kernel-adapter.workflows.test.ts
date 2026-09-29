import { describe, expect, it } from "vitest";
import { DshKernelAdapter } from "./kernel-adapter.js";
import type { WorkflowRunner, WorkflowRunOutcome, WorkflowRunRequest } from "@aigility-harness/core";

const stubRunner: WorkflowRunner = {
  async runWorkflow(_r: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
    return { ok: true, parsed: true, result: { n: 42 }, durationMs: 1 };
  },
};

describe("DshKernelAdapter workflows 接线", () => {
  it("默认不注入时 workflows 为 undefined", () => {
    expect(new DshKernelAdapter().workflows).toBeUndefined();
  });

  it("构造注入的 WorkflowRunner 可经 adapter 到达并执行", async () => {
    const adapter = new DshKernelAdapter({ workflowRunner: stubRunner });
    const outcome = await adapter.workflows!.runWorkflow({
      script: "return 42",
      meta: { name: "t", description: "d" },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ n: 42 });
  });
});
