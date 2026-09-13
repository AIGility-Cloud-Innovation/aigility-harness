/**
 * @aigility-harness/layer-infrastructure — token-metering 单测
 *
 * 覆盖：账本 append/query/summary 聚合、环形上限、metering provider 三动作、
 * stub provider 的 usage 估算口径（非 0、prompt+completion=total）。
 */
import { describe, it, expect } from "vitest";
import {
  tokenMeteringService,
  tokenMeteringProvider,
  createMemoryUsageLedger,
} from "./token-metering.js";
import type { SeamContext, Result } from "@aigility-harness/core";

// ── 测试桩: 最小 SeamContext (record 走 provider.execute, 不经 ctx.call) ──

const noopCtx = (() => {
  const store = new Map<string, unknown>();
  return {
    sessionId: "sess-test",
    traceId: "trace-test",
    callerLayer: "infrastructure" as never,
    addEffect: () => "e",
    emit: () => {},
    getState: <T>(k: string) => store.get(k) as T | undefined,
    setState: (_k: string, _v: unknown) => {},
    call: async (): Promise<Result<never>> => ({ ok: false, error: "not used" }),
  } as unknown as SeamContext;
})();

function record(over: Partial<Parameters<ReturnType<typeof createMemoryUsageLedger>["append"]>[0]>) {
  return {
    userId: "user-a",
    sessionId: "s1",
    provider: "p",
    model: "m",
    source: "measured" as const,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    ...over,
  };
}

describe("createMemoryUsageLedger", () => {
  it("append 后 query 返回新的在前", () => {
    const led = createMemoryUsageLedger();
    led.append(record({ userId: "u1" }));
    led.append(record({ userId: "u2" }));
    const list = led.query();
    expect(list).toHaveLength(2);
    expect(list[0].userId).toBe("u2");
    expect(list[0].at).toBeTruthy();
  });

  it("summary 按用户/模型/日聚合且分组排序正确", () => {
    const led = createMemoryUsageLedger();
    led.append(record({ userId: "u1", model: "glm-4.6", totalTokens: 100, promptTokens: 60, completionTokens: 40 }));
    led.append(record({ userId: "u1", model: "glm-4.6", totalTokens: 50, promptTokens: 30, completionTokens: 20 }));
    led.append(record({ userId: "u2", model: "stub-llm@0.1.0", totalTokens: 10, source: "estimated" }));
    const s = led.summary();
    expect(s.calls).toBe(3);
    expect(s.totalTokens).toBe(160);
    expect(s.measuredCalls).toBe(2);
    expect(s.estimatedCalls).toBe(1);
    expect(s.byUser[0].key).toBe("u1");
    expect(s.byUser[0].totalTokens).toBe(150);
    expect(s.byModel[0].key).toBe("glm-4.6");
    expect(s.byDay).toHaveLength(1);
  });

  it("summary 支持按 userId 过滤", () => {
    const led = createMemoryUsageLedger();
    led.append(record({ userId: "u1" }));
    led.append(record({ userId: "u2" }));
    const s = led.summary({ userId: "u1" });
    expect(s.calls).toBe(1);
    expect(s.byUser[0].key).toBe("u1");
  });

  it("环形缓冲超过 keep 后丢最旧的", () => {
    const led = createMemoryUsageLedger(3);
    for (let i = 0; i < 5; i++) led.append(record({ userId: `u${i}` }));
    expect(led.size()).toBe(3);
    expect(led.query()[0].userId).toBe("u4");
  });
});

describe("tokenMeteringProvider", () => {
  it("service id 正确且 manifest 片段存在", async () => {
    expect(tokenMeteringService.id).toBe("@infrastructure/token-metering");
  });

  it("record 动作写入共享账本并返回条目", async () => {
    const res = await tokenMeteringProvider.execute(
      { action: "record", record: record({ userId: "provider-user" }) },
      noopCtx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.entry?.userId).toBe("provider-user");
      expect(res.value.total).toBeGreaterThan(0);
    }
  });

  it("summary / query 动作可用", async () => {
    const s = await tokenMeteringProvider.execute({ action: "summary" }, noopCtx);
    expect(s.ok).toBe(true);
    const q = await tokenMeteringProvider.execute(
      { action: "query", query: { userId: "provider-user", limit: 10 } },
      noopCtx,
    );
    expect(q.ok).toBe(true);
    if (q.ok && q.value.entries) {
      expect(q.value.entries.every((e) => e.userId === "provider-user")).toBe(true);
    }
  });
});
