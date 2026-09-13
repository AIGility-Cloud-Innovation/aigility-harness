/**
 * Admin module: token-usage — LLM Token 用量（按用户/模型/日聚合）
 * 数据源: @infrastructure/token-metering 的进程内共享账本 (Provider 每次推理上报)。
 * 数字口径: measured = 上游实测; estimated = stub/缺 usage 时按字符估算。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, bearerUser, isAdminUser } from "./context.js";
import { sharedUsageLedger } from "@aigility-harness/layer-infrastructure";

/** Token 用量查询 (管理员); 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== "/app/admin/token-usage") return false;
  if (method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const adminId = bearerUser(req);
  if (!adminId) {
    json(res, 401, { error: "未授权: 请先登录" });
    return true;
  }
  if (!(await isAdminUser(adminId))) {
    json(res, 403, { error: "需要管理员权限" });
    return true;
  }
  const url = new URL(req.url ?? "/", "http://x");
  const userId = url.searchParams.get("userId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  json(res, 200, {
    summary: sharedUsageLedger.summary(userId ? { userId } : {}),
    recent: sharedUsageLedger.query({ userId, limit: Number.isFinite(limit) ? limit : 50 }),
  });
  return true;
}
