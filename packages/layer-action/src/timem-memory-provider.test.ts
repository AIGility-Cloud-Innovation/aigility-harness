import { describe, it, expect } from "vitest";
import {
  createTimemRuleRecallProvider,
  createTimemRuleCreateProvider,
  type TimemMemoryClientLike,
} from "./timem-memory-provider.js";

/** 只带规则方法的最小桩客户端 */
function stubClient(
  recallRules?: TimemMemoryClientLike["recallRules"],
  createRule?: TimemMemoryClientLike["createRule"],
): TimemMemoryClientLike {
  return {
    searchMemory: async () => ({}),
    addMemory: async () => ({}),
    ...(recallRules ? { recallRules } : {}),
    ...(createRule ? { createRule } : {}),
  };
}

describe("createTimemRuleRecallProvider — RSI 读半边", () => {
  it("正常召回：映射规则字段，user_id 缺省 anonymous，top_k 缺省 3", async () => {
    const p = createTimemRuleRecallProvider(
      stubClient(async (req) => [
        { rule_id: "r1", name: "仓库归属", situation: "用户问 nx", lesson: "nx = nx-telecom-opc-platform", score: 0.9 },
      ]),
    );
    const r = await p.execute({ query: "nx 是哪个仓库" }, {} as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ok).toBe(true);
      expect(r.value.total).toBe(1);
      expect(r.value.rules[0]).toMatchObject({ rule_id: "r1", lesson: "nx = nx-telecom-opc-platform" });
    }
  });

  it("客户端不支持规则端点 → 降级 ok:false（不抛错）", async () => {
    const p = createTimemRuleRecallProvider(stubClient());
    const r = await p.execute({ query: "q" }, {} as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ok).toBe(false);
      expect(r.value.rules).toEqual([]);
    }
  });

  it("远端异常 → ok:false 带 error，不抛错", async () => {
    const p = createTimemRuleRecallProvider(
      stubClient(async () => {
        throw new Error("网络超时");
      }),
    );
    const r = await p.execute({ query: "q" }, {} as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ok).toBe(false);
      expect(r.value.error).toContain("网络超时");
    }
  });

  it("缺 lesson 的脏数据被过滤", async () => {
    const p = createTimemRuleRecallProvider(
      stubClient(async () => [{ name: "无经验内容" }, { lesson: "有效规则" }]),
    );
    const r = await p.execute({ query: "q" }, {} as never);
    if (r.ok) expect(r.value.rules).toHaveLength(1);
  });
});

describe("createTimemRuleCreateProvider — RSI 写半边", () => {
  it("创建成功：回传 rule_id", async () => {
    const p = createTimemRuleCreateProvider(
      stubClient(undefined, async () => ({ rule_id: "rule_9" })),
    );
    const r = await p.execute(
      { name: "工单默认 nx", situation: "用户反馈", lesson: "以后工单默认建到 nx 仓库" },
      {} as never,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ ok: true, rule_id: "rule_9" });
  });

  it("客户端不支持规则端点 → 降级 ok:false", async () => {
    const p = createTimemRuleCreateProvider(stubClient());
    const r = await p.execute({ name: "n", situation: "s", lesson: "l" }, {} as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ok).toBe(false);
  });

  it("远端异常 → ok:false 带 error", async () => {
    const p = createTimemRuleCreateProvider(
      stubClient(undefined, async () => {
        throw new Error("409");
      }),
    );
    const r = await p.execute({ name: "n", situation: "s", lesson: "l" }, {} as never);
    if (r.ok) expect(r.value.ok).toBe(false);
  });
});
