/**
 * Admin module: credits — 积分账务（余额/充值/流水/价目）
 * 数据源: @infrastructure/credit 的进程内共享账本 (启动时经 configureCreditStore
 * 换装 PG —— appbase/index.ts main() 步骤 0)。
 * 口径: 1 元 = creditPerYuan 积分; 各模型按倍率计价, 见 pricing 接口。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody, bearerUser, pageUserId, isAdminUser, emailOf } from "./context.js";
import { sharedCreditStore, creditPricing, modelRates } from "@aigility-harness/layer-infrastructure";

/** 价目表 (公开信息): 个人中心 /app/credits/me 与管理面板共用 */
function pricingForUser() {
  return {
    creditPerYuan: creditPricing.creditPerYuan,
    baseCreditsPerMTok: creditPricing.baseCreditsPerMTok,
    outputFactor: creditPricing.outputFactor,
    newUserGrant: creditPricing.newUserGrant,
    models: Object.keys(creditPricing.modelMultipliers).map((model) => ({
      model,
      ...modelRates(creditPricing, model),
    })),
  };
}

/** 积分接口 (管理员 + 用户自身余额); 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  // 用户自身余额 (登录即可, 不要求管理员)
  if (path === "/app/credits/me" && method === "GET") {
    const uid = pageUserId(req);
    if (!uid) {
      json(res, 401, { error: "未授权: 请先登录" });
      return true;
    }
    const email = await emailOfUid(uid);
    const balance = (await sharedCreditStore.getBalance(email ?? uid)) ?? creditPricing.newUserGrant;
    json(res, 200, {
      balance,
      creditPerYuan: creditPricing.creditPerYuan,
      newUserGrant: creditPricing.newUserGrant,
      pricing: pricingForUser(),
    });
    return true;
  }

  if (path !== "/app/admin/credits" && path !== "/app/admin/credits/grant") return false;

  if (method === "GET") {
    if (!(await requireAdmin(req, res))) return true;
    const url = new URL(req.url ?? "/", "http://x");
    const txUser = url.searchParams.get("userId") ?? undefined;
    const models = Object.entries(creditPricing.modelMultipliers).map(([model]) => ({
      model,
      ...modelRates(creditPricing, model),
    }));
    json(res, 200, {
      pricing: {
        creditPerYuan: creditPricing.creditPerYuan,
        baseCreditsPerMTok: creditPricing.baseCreditsPerMTok,
        outputFactor: creditPricing.outputFactor,
        defaultMultiplier: creditPricing.defaultMultiplier,
        newUserGrant: creditPricing.newUserGrant,
        store: sharedCreditStore.kind,
        models,
      },
      accounts: await sharedCreditStore.listAccounts(100),
      transactions: await sharedCreditStore.listTx({ userId: txUser, limit: 100 }),
    });
    return true;
  }

  if (method === "POST" && path === "/app/admin/credits/grant") {
    if (!(await requireAdmin(req, res))) return true;
    const body = await readBody(req);
    const userId = String(body.userId ?? "").trim();
    const credits = Number(body.credits);
    if (!userId || !Number.isFinite(credits) || credits === 0) {
      json(res, 400, { error: "userId 与非 0 credits 必填" });
      return true;
    }
    const { balanceAfter } = await sharedCreditStore.adjust(userId, credits, {
      type: credits > 0 ? "recharge" : "adjust",
      note: String(body.note ?? "管理员操作"),
    });
    json(res, 200, { balanceAfter });
    return true;
  }

  return false;
}

async function requireAdmin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const adminId = bearerUser(req);
  if (!adminId) {
    json(res, 401, { error: "未授权: 请先登录" });
    return false;
  }
  if (!(await isAdminUser(adminId))) {
    json(res, 403, { error: "需要管理员权限" });
    return false;
  }
  return true;
}

async function emailOfUid(uid: string): Promise<string | null> {
  try {
    return await emailOf(uid);
  } catch {
    return null;
  }
}
