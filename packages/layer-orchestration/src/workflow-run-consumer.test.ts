import { describe, expect, it } from "vitest";
import { err, ok } from "@aigility-harness/core";
import type { SeamContext, WorkflowRunOutcome } from "@aigility-harness/core";
import { runWorkflowViaSeam, workflowRunRef } from "./workflow-run-consumer.js";

describe("@harness/workflow-run 消费端接线", () => {
  it("ref 指向家族编排能力", () => {
    expect(workflowRunRef.id).toBe("@harness/workflow-run");
    expect(workflowRunRef.versionRange).toBe("^1.0.0");
  });

  it("runWorkflowViaSeam 经 ctx.call 透传请求并回传结果", async () => {
    const calls: Array<{ ref: unknown; req: unknown }> = [];
    const outcome: WorkflowRunOutcome = {
      ok: true,
      parsed: true,
      result: { done: 1 },
      durationMs: 5,
    };
    const ctx = {
      async call(ref: unknown, req: unknown) {
        calls.push({ ref, req });
        return ok(outcome);
      },
    } as unknown as SeamContext;

    const res = await runWorkflowViaSeam(ctx, {
      script: "return { done: 1 }",
      meta: { name: "t", description: "d" },
      args: { k: "v" },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((calls[0].ref as { id: string }).id).toBe("@harness/workflow-run");
  });

  it("provider 失败时错误如实上抛为 err", async () => {
    const ctx = { async call() { return err("缺少配置: DSH_HOME"); } } as unknown as SeamContext;
    const res = await runWorkflowViaSeam(ctx, {
      script: "",
      meta: { name: "t", description: "d" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("DSH_HOME");
  });
});
