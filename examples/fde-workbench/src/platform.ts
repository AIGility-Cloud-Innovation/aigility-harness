/**
 * fde-workbench 平台底座 —— 复用 AppBase app-backend（examples/appbase）
 *
 * 复用清单（零新造）：
 *   - 账号体系: users 表 + scrypt 哈希 + HMAC token（APPBASE_TOKEN_SECRET/`.token-secret`
 *     与 AppBase 同源 → 两边签发的 token 互通，真正的账号统一）
 *   - 鉴权 API: POST /app/auth/login|register|logout · GET /app/auth/me（限流 + 审计）
 *   - 业务数据: GET/POST/PUT/DELETE /app/data/:table/:rowId?app=fde-workbench
 *     （app_rows JSONB，应用虚拟 owner `app:fde-workbench`，owner∪成员∪管理员共享读写）
 *   - 用量计量: 网关 → POST /app/usage/collect → llm_usage 表（按网关 key 归集）
 *   - 附赠: initAppBackend 的 timem 插件配置→env 桥（内核 bootstrap 前执行，记忆即插即用）
 *
 * fde 侧只新增：演示账号与应用行的幂等种子 + /app/* 路由挂载。
 */

import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  appBackendHandler,
  ensureAppKey,
  initAppBackend,
  pool,
} from "@aigility-harness/appbase/backend";

const scryptAsync = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/** 与 admin-modules/context.hashPassword 同格式（salt:hash hex, scrypt-64） */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export const FDE_APP_ID = "fde-workbench";

/** 演示账号（真实 PG 平台账号；与 AppBase 共库共账号体系） */
const DEMO_ACCOUNTS = [
  { email: "admin@fde.local", password: "admin123" },
  { email: "zhaopeng@fde.local", password: "fde123" },
  { email: "chensiyuan@fde.local", password: "fde123" },
];

export interface FdePlatform {
  /** fde-workbench 应用网关 key（持久化在 app_keys 表，重启不变） */
  gatewayKey: string;
}

/**
 * 幂等种子：账号 → 应用行 → 成员 → 网关 key。必须在内核 bootstrap 前调用
 * （initAppBackend 内的 timem env 桥要求先于 bootstrap 执行）。
 */
export async function ensureFdePlatform(): Promise<FdePlatform> {
  await initAppBackend();

  // 1. 演示账号（已存在则跳过，不覆盖 AppBase 侧的密码/管理员状态）
  let adminId = "";
  for (const acc of DEMO_ACCOUNTS) {
    const { rows: existing } = await pool.query(
      "SELECT id FROM users WHERE email = $1", [acc.email]);
    if (existing.length > 0) {
      if (acc.email === DEMO_ACCOUNTS[0].email) adminId = existing[0].id;
      continue;
    }
    const { rows: anyUser } = await pool.query("SELECT 1 FROM users LIMIT 1");
    // 库为空时 admin@fde.local 首个建号为管理员（与 AppBase「首个注册自动管理员」一致）；
    // 库非空（AppBase 已有账号）则不抢管理员，owner 身份已足够管理本应用数据
    const makeAdmin = acc.email === DEMO_ACCOUNTS[0].email && anyUser.length === 0;
    const id = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, password_hash, is_admin) VALUES ($1,$2,$3,$4)",
      [id, acc.email, await hashPassword(acc.password), makeAdmin]);
    if (acc.email === DEMO_ACCOUNTS[0].email) adminId = id;
  }
  if (!adminId) {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE email = $1", [DEMO_ACCOUNTS[0].email]);
    adminId = rows[0]?.id ?? "";
  }

  // 2. 应用行（数据 API ?app=fde-workbench 的虚拟 owner 依赖它存在）
  await pool.query(
    `INSERT INTO apps (id, owner_id, name, category, html, is_public)
     VALUES ($1,$2,'TiMEM FDE 工作台','workbench','',true)
     ON CONFLICT (id) DO NOTHING`,
    [FDE_APP_ID, adminId]);

  // 3. 全部平台账号自动成为本应用成员（工作台 = 团队共享台账）
  await pool.query(
    `INSERT INTO app_members (app_id, user_id)
     SELECT $1, id FROM users ON CONFLICT DO NOTHING`,
    [FDE_APP_ID]);

  // 4. 应用网关 key（持久化；前端经注入免配置）
  const gatewayKey = await ensureAppKey(FDE_APP_ID, adminId);
  return { gatewayKey };
}

/**
 * Web 端口上的 /app/* 分发（鉴权 + 数据原语 + 用量收集 + 管理面）。
 * 返回 false = 非 /app/* 请求，交给调用方继续处理（静态托管等）。
 */
export async function routePlatform(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (!path.startsWith("/app/")) return false;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  await appBackendHandler(req, res);
  return true;
}
