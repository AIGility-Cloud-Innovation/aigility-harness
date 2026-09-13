/**
 * Admin module: me — 用户个人中心接口 (登录即可, 非管理员)
 * 归因键约定: 积分/用量按 user_key (登录邮箱) 归因, 服务端由当前登录态
 * 解析出邮箱, 一律不接收客户端传入的 userId (只能看自己的数据)。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, pageUserId, emailOf, pool } from "./context.js";
import { sharedCreditStore, sharedUsageLedger } from "@aigility-harness/layer-infrastructure";

/** 个人中心接口; 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!path.startsWith("/app/me/")) return false;
  if (method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const uid = pageUserId(req);
  if (!uid) {
    json(res, 401, { error: "未授权: 请先登录" });
    return true;
  }
  const email = await emailOf(uid).catch(() => null);
  if (!email) {
    json(res, 404, { error: "用户不存在" });
    return true;
  }

  if (path === "/app/me/profile") {
    const { rows } = await pool.query(
      "SELECT email, is_admin, created_at FROM users WHERE id = $1",
      [uid],
    );
    const u = rows[0];
    json(res, 200, {
      email: u?.email ?? email,
      isAdmin: Boolean(u?.is_admin),
      createdAt: u?.created_at ?? null,
    });
    return true;
  }

  if (path === "/app/me/usage") {
    const s = sharedUsageLedger.summary({ userId: email });
    json(res, 200, {
      summary: s,
      recent: sharedUsageLedger.query({ userId: email, limit: 10 }),
    });
    return true;
  }

  if (path === "/app/me/transactions") {
    const url = new URL(req.url ?? "/", "http://x");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    json(res, 200, {
      transactions: await sharedCreditStore.listTx({ userId: email, limit }),
    });
    return true;
  }

  return false;
}
