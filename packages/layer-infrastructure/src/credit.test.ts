/**
 * @aigility-harness/layer-infrastructure — credit 单测
 *
 * 覆盖：定价引擎（倍率/输出系数/取整/表外模型/免费模型）、内存账本
 * （新户赠送、余额累加、流水顺序）、provider 七动作（check/consume/balance/
 * grant/accounts/transactions/pricing）、PG 建表 SQL 纯单元。
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  computeCredits,
  modelRates,
  createMemoryCreditStore,
  creditSetupSql,
  creditService,
  creditProvider,
  creditPricing,
  type CreditPricingConfig,
} from "./credit.js";
import type { SeamContext, Result } from "@aigility-harness/core";

const pricing: CreditPricingConfig = {
  creditPerYuan: 100,
  baseCreditsPerMTok: 200, // ¥2/M 输入 @ 倍率 1
  outputFactor: 4,
  defaultMultiplier: 1,
  newUserGrant: 1000,
  modelMultipliers: {
    "glm-4.6": 1,
    "glm-4.5-air": 0.2,
    "free-model": 0,
    "custom-of": { multiplier: 1, outputFactor: 2 },
  },
};

const noopCtx = {
  sessionId: "s",
  traceId: "t",
  callerLayer: "infrastructure",
  addEffect: () => "e",
  emit: () => {},
  getState: () => undefined,
  setState: () => {},
  call: async (): Promise<Result<never>> => ({ ok: false, error: "unused" }),
} as unknown as SeamContext;

describe("computeCredits 定价引擎", () => {
  it("基准公式: 输入×倍率 + 输出×倍率×输出系数, 2 位小数", () => {
    // glm-4.6: 1M in + 0.5M out = 200 + 0.5×800 = 600 积分
    const r = computeCredits(pricing, "glm-4.6", 1_000_000, 500_000);
    expect(r.credits).toBe(600);
    expect(r.multiplier).toBe(1);
    expect(r.outputFactor).toBe(4);
  });

  it("模型倍率生效: 0.2 倍模型输入 1M = 40 积分", () => {
    expect(computeCredits(pricing, "glm-4.5-air", 1_000_000, 0).credits).toBe(40);
  });

  it("倍率对象可覆写 outputFactor", () => {
    const r = computeCredits(pricing, "custom-of", 1_000_000, 1_000_000);
    expect(r.credits).toBe(200 + 400); // 200 + 1M×200×2
    expect(r.outputFactor).toBe(2);
  });

  it("表外模型用 defaultMultiplier", () => {
    expect(computeCredits(pricing, "unknown-x", 1_000_000, 0).credits).toBe(200);
  });

  it("倍率 0 = 免费模型不计费", () => {
    expect(computeCredits(pricing, "free-model", 1_000_000, 1_000_000).credits).toBe(0);
  });

  it("modelRates 给出每百万输入/输出价", () => {
    const r = modelRates(pricing, "glm-4.6");
    expect(r.input).toBe(200);
    expect(r.output).toBe(800);
  });
});

describe("createMemoryCreditStore", () => {
  it("新账户自动赠送, 首笔消费吃赠送额度", async () => {
    const store = createMemoryCreditStore(1000);
    const { balanceAfter, newAccount } = await store.adjust("u1", -30.5, { type: "consume" });
    expect(newAccount).toBe(true);
    expect(balanceAfter).toBe(969.5);
    const txs = await store.listTx({ userId: "u1" });
    expect(txs.map((t) => t.type)).toEqual(["consume", "grant"]); // 新的在前
    expect(txs[1].credits).toBe(1000);
  });

  it("余额随多笔变动累加, 流水带扣后快照", async () => {
    const store = createMemoryCreditStore(100);
    await store.adjust("u2", 500, { type: "recharge" });
    await store.adjust("u2", -10, { type: "consume" });
    expect(await store.getBalance("u2")).toBe(590);
    const txs = await store.listTx({ userId: "u2" });
    expect(txs[0].balanceAfter).toBe(590);
    expect(txs[1].balanceAfter).toBe(600);
    expect(txs[2].balanceAfter).toBe(100);
  });

  it("listAccounts 按余额降序", async () => {
    const store = createMemoryCreditStore(0);
    await store.adjust("a", 10, { type: "recharge" });
    await store.adjust("b", 99, { type: "recharge" });
    const list = await store.listAccounts();
    expect(list.map((x) => x.userId)).toEqual(["b", "a"]);
  });
});

describe("creditProvider 动作", () => {
  // provider 读模块级生效定价; 本组测试注册一个免费模型到全局价目表
  creditPricing.modelMultipliers["free-model"] = 0;
  afterAll(() => {
    delete creditPricing.modelMultipliers["free-model"];
  });

  it("service id 正确", () => {
    expect(creditService.id).toBe("@infrastructure/credit");
  });

  it("check: 余额充足放行, 不足拒绝; 免费模型恒放行", async () => {
    const okRes = await creditProvider.execute(
      { action: "check", userId: "rich", model: "glm-4.6", promptTokens: 1_000, completionTokens: 1_000 },
      noopCtx,
    );
    expect(okRes.ok && okRes.value.allowed).toBe(true); // 新户赠送 1000 >> 0.4

    // 先清空余额 (赠送 1000 → 扣 1000)
    await creditProvider.execute(
      { action: "consume", userId: "poor", model: "glm-4.6", promptTokens: 5_000_000, completionTokens: 0 },
      noopCtx,
    ); // 恰好扣 1000 → 余额 0
    const deny = await creditProvider.execute(
      { action: "check", userId: "poor", model: "glm-4.6", promptTokens: 1_000, completionTokens: 1_000 },
      noopCtx,
    );
    expect(deny.ok && deny.value.allowed).toBe(false);
    expect(deny.ok && deny.value.balance).toBe(0);

    const free = await creditProvider.execute(
      { action: "check", userId: "poor", model: "free-model", promptTokens: 9_999_999, completionTokens: 9_999_999 },
      noopCtx,
    );
    expect(free.ok && free.value.allowed).toBe(true);
  });

  it("consume: 按定价扣减并返回扣后余额; 免费模型不动账", async () => {
    const r = await creditProvider.execute(
      { action: "consume", userId: "payer", model: "glm-4.5-air", promptTokens: 2_000_000, completionTokens: 1_000_000, source: "measured" },
      noopCtx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2M×40 + 1M×160 = 240
      expect(r.value.chargedCredits).toBe(240);
      expect(r.value.balanceAfter).toBe(creditPricing.newUserGrant - 240);
    }
    const free = await creditProvider.execute(
      { action: "consume", userId: "payer", model: "free-model", promptTokens: 5_000_000, completionTokens: 5_000_000 },
      noopCtx,
    );
    expect(free.ok && free.value.chargedCredits).toBe(0);
  });

  it("grant: 充值/调整落流水", async () => {
    const r = await creditProvider.execute(
      { action: "grant", userId: "grantee", credits: 500, note: "活动赠送" },
      noopCtx,
    );
    expect(r.ok).toBe(true);
    const bal = await creditProvider.execute({ action: "balance", userId: "grantee" }, noopCtx);
    expect(bal.ok && bal.value.balance).toBe(creditPricing.newUserGrant + 500);
  });

  it("pricing: 含汇率与模型价目", async () => {
    const r = await creditProvider.execute({ action: "pricing" }, noopCtx);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.pricing) {
      expect(r.value.pricing.creditPerYuan).toBeGreaterThan(0);
      expect(Array.isArray(r.value.pricing.models)).toBe(true);
    }
  });

  it("accounts / transactions 可用", async () => {
    const a = await creditProvider.execute({ action: "accounts", limit: 10 }, noopCtx);
    expect(a.ok && Array.isArray(a.value.accounts)).toBe(true);
    const t = await creditProvider.execute({ action: "transactions", limit: 10 }, noopCtx);
    expect(t.ok && Array.isArray(t.value.transactions)).toBe(true);
  });
});

describe("creditSetupSql 纯单元", () => {
  it("建表 SQL 含账户/流水两表与索引", () => {
    const sql = creditSetupSql("aigility_credit");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS aigility_credit_account");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS aigility_credit_tx");
    expect(sql).toContain("balance    NUMERIC(14,2)");
    expect(sql).toContain("aigility_credit_tx_user_idx");
  });
});
