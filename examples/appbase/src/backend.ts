/**
 * AppBase 后端 API：auth + apps 表 + 应用数据 (PG JSONB)
 *
 * 被创建的应用 (如 codex 生成的 HTML) 通过这套 API 存取数据:
 *   - POST /app/auth/register|login → token (scrypt 密码哈希 + 自签名 token)
 *   - GET  /app/apps          → 应用列表 (我的/公开)
 *   - POST /app/apps          → 创建应用 (存 HTML)
 *   - GET  /app/apps/:id      → 取应用 (HTML + 元数据)
 *   - PUT  /app/apps/:id      → 更新应用
 *   - DELETE /app/apps/:id    → 删除应用
 *   - GET/POST /app/data/:table      → 应用数据 (按 token owner 隔离)
 *   - PUT/DELETE /app/data/:table/:id → 单行数据
 *
 * 多租户: 应用数据按 owner_id 隔离, 同款应用不同用户看到各自数据。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createMemoryRateLimiter, createMemoryAuditLog } from "@aigility-harness/layer-infrastructure";
import { dshLoadPlugin, dshLoadEnabled, dshStatus } from "./dsh-host.js";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// ── PG 连接 ──────────────────────────────────────────────────────
// 连接信息来自环境变量 (APPBASE_PG_*) 或默认 127.0.0.1:5433 appbase 库。
// 端口约定: 本机用 Docker 容器 appbase-pg (宿主 5433 → 容器 5432), 与此默认值对齐,
//           无需设 APPBASE_PG_PORT; 原生 PG 跑在默认 5432 的机器需设 APPBASE_PG_PORT=5432。
// 密码不硬编码: 读 APPBASE_PG_PASSWORD / PGPASSWORD (本机容器密码见 start-appbase.cmd)。

const PG_CONFIG = {
  host: process.env.APPBASE_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.APPBASE_PG_PORT ?? 5433),
  database: process.env.APPBASE_PG_DATABASE ?? "appbase",
  user: process.env.APPBASE_PG_USER ?? "postgres",
  password: process.env.APPBASE_PG_PASSWORD ?? process.env.PGPASSWORD ?? "",
};

const pool = new pg.Pool(PG_CONFIG);

// ── 建表 (幂等) ──────────────────────────────────────────────────

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 管理员标记 (大厅全功能); 与环境变量 APPBASE_ADMIN_EMAILS 白名单取并集
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    -- 大厅应用成员: 被添加的账号在主页可见该应用 (管理员始终可见全部)
    CREATE TABLE IF NOT EXISTS app_members (
      app_id   TEXT NOT NULL,
      user_id  TEXT NOT NULL REFERENCES users(id),
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (app_id, user_id)
    );
    -- 应用报修工单
    CREATE TABLE IF NOT EXISTS repair_tickets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      app        TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'open',
      solution   TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_repair_tickets_user ON repair_tickets(user_id);
    -- 审计日志 (持久层; 内存环形由框架 audit 插件持有)
    CREATE TABLE IF NOT EXISTS audit_log (
      id         BIGSERIAL PRIMARY KEY,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT NOT NULL DEFAULT '',
      detail     TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);
    -- DSH 插件注册表 (cordis 插件 + 配置; apikey 等机密存库, API 返回时掩码)
    CREATE TABLE IF NOT EXISTS dsh_plugins (
      name        TEXT PRIMARY KEY,
      package     TEXT NOT NULL,
      export_name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled     BOOLEAN NOT NULL DEFAULT false,
      config      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_tables (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      table_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (owner_id, table_name)
    );
    CREATE TABLE IF NOT EXISTS app_rows (
      id         TEXT PRIMARY KEY,
      table_id   TEXT NOT NULL REFERENCES app_tables(id),
      owner_id   TEXT NOT NULL,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_app_rows_table ON app_rows(table_id);
    CREATE TABLE IF NOT EXISTS classes (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS class_members (
      class_code TEXT NOT NULL REFERENCES classes(code),
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'teacher',
      joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (class_code, user_id)
    );
    CREATE TABLE IF NOT EXISTS app_accounts (
      id            TEXT PRIMARY KEY,
      app_id        TEXT NOT NULL,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      note          TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (app_id, username)
    );
    CREATE TABLE IF NOT EXISTS app_keys (
      id         TEXT PRIMARY KEY,
      app_id     TEXT NOT NULL,
      key        TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL DEFAULT '',
      account_id TEXT,
      revoked    BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_llm_config (
      app_id     TEXT PRIMARY KEY,
      url        TEXT NOT NULL DEFAULT '',
      key        TEXT NOT NULL DEFAULT '',
      model      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE app_llm_config ADD COLUMN IF NOT EXISTS env JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS llm_usage (
      id               TEXT PRIMARY KEY,
      key              TEXT NOT NULL,
      model            TEXT NOT NULL,
      prompt_tokens    INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens     INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_key ON llm_usage(key);
    CREATE TABLE IF NOT EXISTS apps (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'general',
      html        TEXT NOT NULL DEFAULT '',
      is_public   BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(owner_id);
  `);
}

// ── 工具 ─────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const hash = await scryptAsync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hashHex, "hex"), hash);
}

/** token 有效期 (毫秒): 默认 7 天 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * token 签名密钥: 优先环境变量; 否则用本地持久化的随机密钥
 * (首次生成写入 examples/appbase/.token-secret, 重启后 token 不失效)。
 * 不再回退到公开的固定盐, 避免 token 可被伪造。
 */
function getTokenSecret(): string {
  const fromEnv = process.env.APPBASE_TOKEN_SECRET;
  if (fromEnv) return fromEnv;
  const secretFile = join(dirname(fileURLToPath(import.meta.url)), ".token-secret");
  try {
    const existing = readFileSync(secretFile, "utf8").trim();
    if (existing) return existing;
  } catch { /* 首次运行, 文件不存在 */ }
  const generated = randomBytes(32).toString("hex");
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

function signToken(userId: string): string {
  // 自签名 token: userId.random.exp.sig (无第三方依赖)
  const payload = `${userId}.${randomBytes(24).toString("hex")}.${Date.now() + TOKEN_TTL_MS}`;
  const sig = createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, nonce, expStr, sig] = parts;
  const payload = `${userId}.${nonce}.${expStr}`;
  const expected = createHmac("sha256", getTokenSecret()).update(payload).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  if (!Number.isFinite(Number(expStr)) || Number(expStr) < Date.now()) return null;
  return userId;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── 管理员 / 成员 ────────────────────────────────────────────────

/** 管理员邮箱白名单 (环境变量 APPBASE_ADMIN_EMAILS, 逗号分隔; 与 users.is_admin 取并集) */
function adminEmails(): string[] {
  return (process.env.APPBASE_ADMIN_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 该登录用户是否管理员: is_admin 列或邮箱白名单 */
export async function isAdminUser(userId: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT email, is_admin FROM users WHERE id = $1", [userId]);
  if (rows.length === 0) return false;
  return Boolean(rows[0].is_admin) || adminEmails().includes(rows[0].email);
}

/** 从请求头解析登录用户 id: 无/无效 token 返回 null */
export function bearerUser(req: { headers: { authorization?: string | string[] } }): string | null {
  const raw = req.headers.authorization;
  const auth = Array.isArray(raw) ? raw[0] : raw;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  return token ? verifyToken(token) : null;
}

/**
 * 页面路由专用的身份解析: Bearer 头 或 httpOnly cookie (hall_token)。
 * 仅用于 HTML 页面门禁 (浏览器 location 导航带不了 Authorization 头)。
 * API 一律仍走 bearerUser —— 纯 cookie 调 API 一律 401,
 * 这样同源生成的应用页即使偷不到/发不出 token 也调不了接口。
 */
export function pageUserId(req: { headers: { authorization?: string | string[]; cookie?: string } }): string | null {
  const viaHeader = bearerUser(req);
  if (viaHeader) return viaHeader;
  const m = /(?:^|;\s*)hall_token=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m ? verifyToken(decodeURIComponent(m[1])) : null;
}

/** 给登录/注册响应签发 httpOnly cookie (页面导航门禁用; API 不认 cookie) */
export function setAuthCookie(res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie",
    `hall_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
}

// ── 登录限流 / 审计 (框架插件能力: @infrastructure/rate-limit + audit) ──
const loginLimiter = createMemoryRateLimiter({ maxFails: 5, lockMs: 15 * 60 * 1000 });
const auditRing = createMemoryAuditLog();

export function loginLockKey(req: { socket?: { remoteAddress?: string } }, email: string): string {
  return `${req.socket?.remoteAddress ?? "unknown"}|${email.toLowerCase()}`;
}

/**
 * 审计留痕: 敏感操作双写 —— 框架内存环形 (供 ctx.call 消费) + PG audit_log 表 (持久, 重启不丢)。
 * 写 PG 失败不阻塞业务。
 */
export async function writeAudit(actor: string, action: string, target?: string, detail?: string): Promise<void> {
  auditRing.append({ actor, action, target, detail });
  try {
    await pool.query(
      "INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)",
      [actor, action, target ?? "", detail ?? ""]);
  } catch (e) {
    console.error("[audit] pg write failed:", e);
  }
}

/** 用户 id → 邮箱 (审计显示用; 查不到原样返回) */
export async function emailOf(userId: string): Promise<string> {
  const { rows } = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
  return rows[0]?.email ?? userId;
}

/** 用户可见的大厅沙箱应用: 管理员=全部; 普通用户=被添加的应用 ∪ 自己名下注册的应用 */
export async function visibleHallApps(allApps: string[], userId: string, isAdmin: boolean): Promise<string[]> {
  if (isAdmin) return allApps;
  const { rows } = await pool.query(
    `SELECT app_id FROM app_members WHERE user_id = $1
     UNION
     SELECT id AS app_id FROM apps WHERE owner_id = $1 AND category = 'hall'`,
    [userId]);
  const visible = new Set(rows.map((r: any) => r.app_id));
  return allApps.filter((a) => visible.has(a));
}

// ── 路由 ─────────────────────────────────────────────────────────

export async function appBackendHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    // ── auth ──
    // 注册开关: 设 APPBASE_ALLOW_REGISTER=false 后仅已有账号可登录
    if (method === "POST" && path === "/app/auth/register") {
      if (process.env.APPBASE_ALLOW_REGISTER === "false") {
        return json(res, 403, { error: "本站已关闭注册, 请联系管理员开通账号" });
      }
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email || password.length < 6) {
        return json(res, 400, { error: "email 和 password(≥6位) 必填" });
      }
      const id = randomUUID();
      const hash = await hashPassword(password);
      // 首个注册用户自动成为管理员 (兜底引导); 邮箱白名单内的也直接是管理员
      const { rows: admins } = await pool.query("SELECT 1 FROM users WHERE is_admin LIMIT 1");
      const makeAdmin = adminEmails().includes(email)
        || (admins.length === 0 && adminEmails().length === 0);
      try {
        await pool.query(
          "INSERT INTO users (id, email, password_hash, is_admin) VALUES ($1, $2, $3, $4)",
          [id, email, hash, makeAdmin],
        );
      } catch (e: any) {
        if (String(e?.code) === "23505") return json(res, 409, { error: "邮箱已注册" });
        throw e;
      }
      const token = signToken(id);
      setAuthCookie(res, token);
      void writeAudit(email, "register", email, makeAdmin ? "(首个用户, 自动管理员)" : "");
      return json(res, 201, { token, user: { id, email, isAdmin: makeAdmin } });
    }

    if (method === "POST" && path === "/app/auth/login") {
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const ip = req.socket?.remoteAddress ?? "unknown";
      // 限流 (框架 @infrastructure/rate-limit): 同 IP+邮箱 5 次失败锁 15 分钟
      const lockKey = loginLockKey(req, email);
      const lock = loginLimiter.check(lockKey);
      if (lock.locked) {
        void writeAudit(email, "login.locked", email, `ip=${ip} 剩余约 ${lock.retryAfterMin} 分钟`);
        return json(res, 429, { error: `失败次数过多, 账号已锁定, 约 ${lock.retryAfterMin} 分钟后再试` });
      }
      const { rows } = await pool.query(
        "SELECT id, email, password_hash, is_admin FROM users WHERE email = $1",
        [email],
      );
      if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
        const after = loginLimiter.fail(lockKey);
        void writeAudit(email, "login.fail", email,
          `ip=${ip}` + (after.remaining > 0 ? ` 还可尝试 ${after.remaining} 次` : " (触发锁定)"));
        return json(res, 401, { error: after.remaining > 0 ? `邮箱或密码错误 (还可尝试 ${after.remaining} 次)` : "邮箱或密码错误" });
      }
      loginLimiter.reset(lockKey);
      const token = signToken(rows[0].id);
      const isAdmin = Boolean(rows[0].is_admin) || adminEmails().includes(email);
      setAuthCookie(res, token);
      void writeAudit(email, "login", email, `ip=${ip}${isAdmin ? " (管理员)" : ""}`);
      return json(res, 200, { token, user: { id: rows[0].id, email: rows[0].email, isAdmin } });
    }

    // 登出: 清除 httpOnly cookie (前端同时清 sessionStorage)
    if (method === "POST" && path === "/app/auth/logout") {
      res.setHeader("Set-Cookie", "hall_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // 当前登录者信息 (前端启动时校验 token / 拿管理员身份)
    if (method === "GET" && path === "/app/auth/me") {
      const userId = bearerUser(req);
      if (!userId) return json(res, 401, { error: "未登录" });
      const { rows } = await pool.query("SELECT id, email FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) return json(res, 401, { error: "用户不存在" });
      return json(res, 200, {
        user: { id: rows[0].id, email: rows[0].email, isAdmin: await isAdminUser(userId) },
      });
    }

    // ── 管理员: 用户管理 + 审计查询 (专门的用户管理应用使用) ──
    if (path.startsWith("/app/admin/")) {
      const adminId = bearerUser(req);
      if (!adminId) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(adminId))) return json(res, 403, { error: "需要管理员权限" });

      if (method === "GET" && path === "/app/admin/users") {
        const { rows } = await pool.query(
          `SELECT u.id, u.email, u.is_admin, u.created_at,
                  (SELECT count(*)::int FROM app_members m WHERE m.user_id = u.id) AS member_count,
                  (SELECT count(*)::int FROM apps a WHERE a.owner_id = u.id) AS app_count
           FROM users u ORDER BY u.created_at`);
        return json(res, 200, { users: rows });
      }

      if (method === "GET" && path === "/app/admin/audit") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const { rows } = await pool.query(
          "SELECT actor, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1",
          [limit]);
        return json(res, 200, { entries: rows });
      }

      // 全部应用内账号 (跨应用统一视图, 用户管理页使用)
      if (method === "GET" && path === "/app/admin/app-accounts") {
        const { rows } = await pool.query(
          `SELECT a.id, a.app_id, a.username, a.note, a.created_at,
                  COALESCE((SELECT count(*)::int FROM app_keys k
                            WHERE k.app_id = a.app_id AND k.revoked = false), 0) AS key_count
           FROM app_accounts a ORDER BY a.app_id, a.created_at`);
        return json(res, 200, { accounts: rows });
      }

      const adminUserMatch = path.match(/^\/app\/admin\/users\/([^/]+)(?:\/([a-z]+))?$/);
      if (adminUserMatch) {
        const targetId = decodeURIComponent(adminUserMatch[1]);
        const sub = adminUserMatch[2] ?? "";
        const adminEmail = await emailOf(adminId);

        if (method === "GET" && sub === "memberships") {
          const { rows } = await pool.query(
            "SELECT app_id, added_at FROM app_members WHERE user_id = $1 ORDER BY added_at",
            [targetId]);
          return json(res, 200, { memberships: rows });
        }

        if (method === "PUT" && sub === "admin") {
          const body = await readBody(req);
          if (targetId === adminId && body.is_admin !== true) {
            return json(res, 400, { error: "不能撤销自己的管理员身份" });
          }
          // 撤销管理员时, 必须还存在其他管理员
          const { rowCount } = await pool.query(
            `UPDATE users SET is_admin = $2 WHERE id = $1
             AND ($2 = true OR (SELECT count(*) FROM users WHERE is_admin AND id <> $1) > 0)`,
            [targetId, Boolean(body.is_admin)]);
          if (rowCount === 0) {
            return json(res, body.is_admin ? 404 : 400,
              body.is_admin ? { error: "用户不存在" } : { error: "至少要保留一名管理员" });
          }
          void writeAudit(adminEmail, "user.set_admin", await emailOf(targetId),
            body.is_admin ? "设为管理员" : "取消管理员");
          return json(res, 200, { ok: true });
        }

        if (method === "PUT" && sub === "password") {
          const body = await readBody(req);
          const newPassword = String(body.newPassword ?? "");
          if (newPassword.length < 6) return json(res, 400, { error: "新密码至少 6 位" });
          const hash = await hashPassword(newPassword);
          const { rowCount } = await pool.query(
            "UPDATE users SET password_hash = $2 WHERE id = $1", [targetId, hash]);
          if (rowCount === 0) return json(res, 404, { error: "用户不存在" });
          void writeAudit(adminEmail, "user.reset_password", await emailOf(targetId));
          return json(res, 200, { ok: true });
        }

        if (method === "DELETE" && sub === "member") {
          const appId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
          if (!appId) return json(res, 400, { error: "缺少 app 参数" });
          await pool.query("DELETE FROM app_members WHERE user_id = $1 AND app_id = $2",
            [targetId, appId]);
          void writeAudit(adminEmail, "app.member_remove", appId, `移出 ${await emailOf(targetId)}`);
          return json(res, 200, { ok: true });
        }

        if (method === "DELETE" && sub === "") {
          if (targetId === adminId) return json(res, 400, { error: "不能删除自己的账号" });
          const { rows: owned } = await pool.query(
            "SELECT count(*)::int AS n FROM apps WHERE owner_id = $1", [targetId]);
          if (owned[0].n > 0) {
            return json(res, 409, { error: `该用户名下还有 ${owned[0].n} 个应用, 请先处理应用归属再删除` });
          }
          await pool.query("DELETE FROM app_members WHERE user_id = $1", [targetId]);
          const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [targetId]);
          if (rowCount === 0) return json(res, 404, { error: "用户不存在" });
          void writeAudit(adminEmail, "user.delete", await emailOf(targetId));
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "admin: not found" });
    }

    // ── 管理员: DSH 插件管理 (cordis 插件注册/配置/加载) ──
    if (path.startsWith("/app/dsh/plugins")) {
      const adminId = bearerUser(req);
      if (!adminId) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(adminId))) return json(res, 403, { error: "需要管理员权限" });
      const adminEmail = await emailOf(adminId);

      // 机密配置项 (apikey/token/...) 回给前端时掩码; 保存时值为 •••• 开头 = 保持不变
      const SECRET_RE = /key|secret|token|password/i;
      const maskConfig = (cfg: Record<string, unknown>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg ?? {})) {
          const s = String(v ?? "");
          out[k] = SECRET_RE.test(k) ? (s ? "••••" + s.slice(-4) : "") : s;
        }
        return out;
      };

      if (method === "GET" && path === "/app/dsh/plugins") {
        const { rows } = await pool.query(
          "SELECT name, package, export_name, description, enabled, config FROM dsh_plugins ORDER BY name");
        return json(res, 200, {
          plugins: rows.map((r) => ({ ...r, config: maskConfig(r.config ?? {}) })),
          runtime: dshStatus(),
        });
      }

      // 注册新插件
      if (method === "POST" && path === "/app/dsh/plugins") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        const pkg = String(body.package ?? "").trim();
        if (!name || !pkg) return json(res, 400, { error: "name 和 package 必填" });
        try {
          await pool.query(
            `INSERT INTO dsh_plugins (name, package, export_name, description, config)
             VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [name, pkg, String(body.exportName ?? "").trim(), String(body.description ?? "").trim(),
             JSON.stringify(body.config ?? {})]);
        } catch (e: any) {
          if (String(e?.code) === "23505") return json(res, 409, { error: "同名插件已存在" });
          throw e;
        }
        void writeAudit(adminEmail, "dsh.plugin_register", name, pkg);
        return json(res, 201, { ok: true });
      }

      const dshMatch = path.match(/^\/app\/dsh\/plugins\/([^/]+)$/);
      const dshAction = path.match(/^\/app\/dsh\/plugins\/([^/]+)\/(load|unload)$/);
      if (dshMatch || dshAction) {
        const name = decodeURIComponent((dshAction ?? dshMatch)![1]);

        const fetchRec = async () => {
          const { rows } = await pool.query(
            "SELECT name, package, export_name, description, enabled, config FROM dsh_plugins WHERE name = $1",
            [name]);
          return rows[0];
        };

        // 启用/停用 + 保存配置
        if (method === "PUT" && dshMatch) {
          const rec = await fetchRec();
          if (!rec) return json(res, 404, { error: "插件不存在" });
          const body = await readBody(req);
          const enabled = body.enabled !== undefined ? Boolean(body.enabled) : rec.enabled;
          let config = rec.config ?? {};
          if (typeof body.configText === "string") {
            const parsed = parseEnvText(body.configText);
            const merged: Record<string, unknown> = { ...config };
            for (const [k, v] of Object.entries(parsed)) {
              // 掩码值 (•••• 开头) = 保持原值不变
              merged[k] = v.startsWith("••••") ? merged[k] ?? "" : v;
            }
            config = merged;
          }
          await pool.query(
            "UPDATE dsh_plugins SET enabled = $2, config = $3::jsonb, updated_at = now() WHERE name = $1",
            [name, enabled, JSON.stringify(config)]);
          void writeAudit(adminEmail, "dsh.plugin_config", name,
            [body.enabled !== undefined ? `enabled=${enabled}` : null, body.configText !== undefined ? "配置已保存" : null]
              .filter(Boolean).join(", "));
          return json(res, 200, { ok: true });
        }

        // 加载 (手动; 未启用的也可以手动试载)
        if (method === "POST" && dshAction && dshAction[2] === "load") {
          const rec = await fetchRec();
          if (!rec) return json(res, 404, { error: "插件不存在" });
          const result = await dshLoadPlugin({
            name: rec.name, package: rec.package, export_name: rec.export_name, config: rec.config ?? {},
          });
          void writeAudit(adminEmail, "dsh.plugin_load", name, result.ok ? "加载成功" : `失败: ${result.error}`);
          return json(res, result.ok ? 200 : 500, result);
        }

        // 停用 = 重建宿主, 只加载其余启用的插件
        if (method === "POST" && dshAction && dshAction[2] === "unload") {
          const { rows } = await pool.query(
            "SELECT name, package, export_name, config FROM dsh_plugins WHERE enabled = true AND name <> $1",
            [name]);
          const results = await dshLoadEnabled(rows.map((r) => ({
            name: r.name, package: r.package, export_name: r.export_name, config: r.config ?? {},
          })));
          void writeAudit(adminEmail, "dsh.plugin_unload", name);
          return json(res, 200, { ok: true, reloaded: results });
        }
      }

      const dshDel = path.match(/^\/app\/dsh\/plugins\/([^/]+)$/);
      if (method === "DELETE" && dshDel) {
        const name = decodeURIComponent(dshDel[1]);
        await pool.query("DELETE FROM dsh_plugins WHERE name = $1", [name]);
        const { rows } = await pool.query(
          "SELECT name, package, export_name, config FROM dsh_plugins WHERE enabled = true");
        await dshLoadEnabled(rows.map((r) => ({
          name: r.name, package: r.package, export_name: r.export_name, config: r.config ?? {},
        })));
        void writeAudit(adminEmail, "dsh.plugin_delete", name);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "dsh: not found" });
    }

    // ── 报修工单 (登录用户: 自己的工单; 管理员: 全部) ──
    if (path === "/app/tickets" || path.startsWith("/app/tickets/")) {
      const ticketUserId = bearerUser(req);
      if (!ticketUserId) return json(res, 401, { error: "未授权: 请先登录" });
      const ticketAdmin = await isAdminUser(ticketUserId);

      if (method === "GET" && path === "/app/tickets") {
        const { rows } = await pool.query(
          `SELECT t.*, u.email AS owner_email FROM repair_tickets t
           JOIN users u ON u.id = t.user_id
           ${ticketAdmin ? "" : "WHERE t.user_id = $1"}
           ORDER BY t.created_at DESC LIMIT 200`,
          ticketAdmin ? [] : [ticketUserId]);
        return json(res, 200, { tickets: rows, isAdmin: ticketAdmin });
      }

      if (method === "POST" && path === "/app/tickets") {
        const body = await readBody(req);
        const title = String(body.title ?? "").trim();
        if (!title) return json(res, 400, { error: "title 必填" });
        const id = randomUUID();
        await pool.query(
          "INSERT INTO repair_tickets (id, user_id, app, title, detail) VALUES ($1,$2,$3,$4,$5)",
          [id, ticketUserId, String(body.app ?? "").trim(), title, String(body.detail ?? "").trim()]);
        return json(res, 201, { id });
      }

      const ticketMatch = path.match(/^\/app\/tickets\/([^/]+)$/);
      if (ticketMatch && method === "PUT") {
        const ticketId = decodeURIComponent(ticketMatch[1]);
        const { rows: own } = await pool.query(
          "SELECT user_id FROM repair_tickets WHERE id = $1", [ticketId]);
        if (own.length === 0) return json(res, 404, { error: "工单不存在" });
        if (own[0].user_id !== ticketUserId && !ticketAdmin) {
          return json(res, 403, { error: "只能操作自己的工单" });
        }
        const body = await readBody(req);
        const status = ["open", "resolved"].includes(String(body.status))
          ? String(body.status) : undefined;
        const solution = body.solution !== undefined ? String(body.solution) : undefined;
        const { rowCount } = await pool.query(
          `UPDATE repair_tickets SET
             status = COALESCE($2, status),
             solution = COALESCE($3, solution),
             updated_at = now()
           WHERE id = $1`,
          [ticketId, status ?? null, solution ?? null]);
        if (rowCount === 0) return json(res, 404, { error: "工单不存在" });
        return json(res, 200, { ok: true });
      }
    }

    // ── 应用账号登录 (用户名+密码, 与 AppBase 主账号体系无关) ──
    if (method === "POST" && path === "/app/hall/appauth/login") {
      const body = await readBody(req);
      const appId = String(body.app ?? "");
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const { rows } = await pool.query(
        "SELECT id, password_hash FROM app_accounts WHERE app_id = $1 AND username = $2",
        [appId, username]);
      if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
        return json(res, 401, { error: "用户名或密码错误" });
      }
      const subject = "appacc:" + rows[0].id;
      return json(res, 200, { token: signToken(subject), username, accountId: rows[0].id });
    }

    // 应用账号改密 (本人凭旧密码)
    if (method === "POST" && path === "/app/hall/appauth/password") {
      const body = await readBody(req);
      const auth = req.headers.authorization ?? "";
      const subject = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
      if (!subject || !subject.startsWith("appacc:")) return json(res, 401, { error: "未授权" });
      const accountId = subject.slice(7);
      const username = String(body.username ?? "").trim();
      const oldPassword = String(body.oldPassword ?? "");
      const newPassword = String(body.newPassword ?? "");
      const appIdBody = String(body.app ?? "");
      if (newPassword.length < 4) return json(res, 400, { error: "新密码至少 4 位" });
      const { rows } = await pool.query(
        "SELECT password_hash FROM app_accounts WHERE id = $1 AND app_id = $2 AND username = $3",
        [accountId, appIdBody, username]);
      if (rows.length === 0 || !(await verifyPassword(oldPassword, rows[0].password_hash))) {
        return json(res, 401, { error: "旧密码错误" });
      }
      const hash = await hashPassword(newPassword);
      await pool.query("UPDATE app_accounts SET password_hash = $1 WHERE id = $2", [hash, accountId]);
      return json(res, 200, { ok: true });
    }

    // 应用读取自己的 .env (需应用账号 token)
    if (method === "GET" && path === "/app/hall/appauth/env") {
      const auth3 = req.headers.authorization ?? "";
      const subj3 = auth3.startsWith("Bearer ") ? verifyToken(auth3.slice(7)) : null;
      if (!subj3 || !subj3.startsWith("appacc:")) return json(res, 401, { error: "未授权" });
      const envApp = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      const { rows } = await pool.query(
        "SELECT env FROM app_llm_config WHERE app_id = $1", [envApp]);
      return json(res, 200, { env: rows[0]?.env ?? {} });
    }

    // ── LLM 代理: 应用凭 app-token 调用, 上游配置存服务端 (Key 不出后端) ──
    if (method === "POST" && path === "/app/hall/llm") {
      const auth = req.headers.authorization ?? "";
      const subject = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
      if (!subject || !subject.startsWith("appacc:")) return json(res, 401, { error: "未授权: 需要应用账号 token" });
      const body = await readBody(req);
      const llmAppId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      const { rows } = await pool.query("SELECT url, key, model FROM app_llm_config WHERE app_id = $1", [llmAppId]);
      let url = rows[0]?.url ?? "";
      let key = rows[0]?.key ?? "";
      let model = rows[0]?.model ?? "";
      // 未配置时回退全局默认 (环境变量)
      url = url || process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
      key = key || process.env.BIGMODEL_API_KEY || "";
      model = model || process.env.LLM_MODEL || "glm-4.6";
      if (!key) return json(res, 500, { error: "该应用尚未配置 LLM, 请管理员在大厅设置" });
      body.model = model; // 始终使用管理员配置的模型
      const target = normalizeLlmBase(url) + "/chat/completions";
      console.log("[llm-proxy] ->", target, "model:", body.model);
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await upstream.text();
      if (!upstream.ok) console.error("[llm-proxy] upstream", upstream.status, text.slice(0, 200));
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }

    // ── 应用管理: 账号 / API Key / LLM 用量 (需登录用户) ──
    if (path.startsWith("/app/hall/manage") || path === "/app/usage/collect") {
      // 用量收集: 仅限内网网关 (共享密钥), 无用户 token
      if (path === "/app/usage/collect" && method === "POST") {
        const adminKey = req.headers.authorization ?? "";
        if (adminKey !== "Bearer " + (process.env.APPBASE_GATEWAY_KEY ?? "")) {
          return json(res, 401, { error: "collect: bad gateway key" });
        }
        const body = await readBody(req);
        const id = randomUUID();
        await pool.query(
          `INSERT INTO llm_usage (id, key, model, prompt_tokens, completion_tokens, total_tokens)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, String(body.key ?? ""), String(body.model ?? "?"),
           Number(body.usage?.prompt_tokens ?? 0), Number(body.usage?.completion_tokens ?? 0),
           Number(body.usage?.total_tokens ?? 0)],
        );
        return json(res, 200, { ok: true });
      }

      const auth = req.headers.authorization ?? "";
      const userId = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
      if (!userId) return json(res, 401, { error: "未授权: 先登录" });
      const appId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      if (!appId) return json(res, 400, { error: "缺少 app 参数" });
      // 应用可以是 DB 里的应用, 也可以是大厅沙箱文件 (首次管理时自动注册)
      let own = await pool.query("SELECT id FROM apps WHERE id = $1 AND owner_id = $2", [appId, userId]);
      if (own.rows.length === 0 && /^[\w一-龥-]+\.html$/.test(appId)) {
        await pool.query(
          "INSERT INTO apps (id, owner_id, name, category, html, is_public) VALUES ($1,$2,$3,'hall','',true) ON CONFLICT DO NOTHING",
          [appId, userId, appId]);
        own = await pool.query("SELECT id FROM apps WHERE id = $1 AND owner_id = $2", [appId, userId]);
      }
      // 管理者 = 应用 owner 或管理员 (管理员可管理所有应用)
      if (own.rows.length === 0 && !(await isAdminUser(userId))) {
        return json(res, 403, { error: "不是该应用的管理者" });
      }

      if (method === "GET" && path === "/app/hall/manage") {
        const { rows: accounts } = await pool.query(
          "SELECT id, username, note, created_at FROM app_accounts WHERE app_id = $1 ORDER BY created_at",
          [appId]);
        const { rows: members } = await pool.query(
          `SELECT m.user_id, u.email, m.added_at FROM app_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.app_id = $1 ORDER BY m.added_at`, [appId]);
        const { rows: keys } = await pool.query(
          "SELECT id, key, label, revoked, created_at FROM app_keys WHERE app_id = $1 ORDER BY created_at",
          [appId]);
        const { rows: usage } = await pool.query(
          `SELECT u.key, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.created_at,
                  COALESCE(a.username, '') AS account
           FROM llm_usage u
           JOIN app_keys k ON k.key = u.key AND k.app_id = $1
           LEFT JOIN app_accounts a ON a.id = k.account_id
           ORDER BY u.created_at DESC LIMIT 100`, [appId]);
        const { rows: agg } = await pool.query(
          `SELECT COALESCE(a.username, k.label, k.key) AS who, COUNT(*)::int AS calls,
                  SUM(u.total_tokens)::int AS tokens
           FROM llm_usage u
           JOIN app_keys k ON k.key = u.key AND k.app_id = $1
           LEFT JOIN app_accounts a ON a.id = k.account_id
           GROUP BY 1 ORDER BY tokens DESC`, [appId]);
        const { rows: llm } = await pool.query(
          "SELECT url, key, model, env, updated_at FROM app_llm_config WHERE app_id = $1", [appId]);
        const llmCfg = llm[0] ?? { url: "", key: "", model: "", env: {}, updated_at: null };
        return json(res, 200, {
          accounts, members, keys, usage, agg,
          llm: { url: llmCfg.url, model: llmCfg.model,
                 keyMasked: llmCfg.key ? "••••" + llmCfg.key.slice(-4) : "",
                 hasKey: Boolean(llmCfg.key), updated_at: llmCfg.updated_at },
          envText: envToText(llmCfg.env),
        });
      }

      // 大厅成员: 把已注册账号添加进该应用 (添加后对方主页可见)
      if (method === "POST" && path === "/app/hall/manage/member") {
        const body = await readBody(req);
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!email) return json(res, 400, { error: "email 必填" });
        const { rows: u } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        if (u.length === 0) return json(res, 404, { error: "该邮箱尚未注册 (对方需先在大厅注册账号)" });
        await pool.query(
          "INSERT INTO app_members (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [appId, u[0].id]);
        return json(res, 200, { ok: true });
      }
      const delMember = path.match(/^\/app\/hall\/manage\/member\/([^/]+)$/);
      if (method === "DELETE" && delMember) {
        await pool.query("DELETE FROM app_members WHERE app_id = $1 AND user_id = $2",
          [appId, decodeURIComponent(delMember[1])]);
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/app/hall/manage/account") {
        const body = await readBody(req);
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        if (!username || password.length < 4) return json(res, 400, { error: "用户名必填, 密码≥4位" });
        const id = randomUUID();
        const hash = await hashPassword(password);
        try {
          await pool.query(
            "INSERT INTO app_accounts (id, app_id, username, password_hash, note) VALUES ($1,$2,$3,$4,$5)",
            [id, appId, username, hash, String(body.note ?? "")]);
        } catch (e: any) {
          if (String(e?.code) === "23505") return json(res, 409, { error: "用户名已存在" });
          throw e;
        }
        void writeAudit(await emailOf(userId), "appaccount.add", appId, username);
        return json(res, 201, { id });
      }
      const delAcc = path.match(/^\/app\/hall\/manage\/account\/([^/]+)$/);
      if (method === "DELETE" && delAcc) {
        const { rows: accRow } = await pool.query(
          "SELECT username FROM app_accounts WHERE id = $1 AND app_id = $2",
          [decodeURIComponent(delAcc[1]), appId]);
        await pool.query("DELETE FROM app_accounts WHERE id = $1 AND app_id = $2",
          [decodeURIComponent(delAcc[1]), appId]);
        if (accRow[0]) void writeAudit(await emailOf(userId), "appaccount.delete", appId, accRow[0].username);
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/app/hall/manage/key") {
        const body = await readBody(req);
        const id = randomUUID();
        const key = "sk-app-" + randomBytes(16).toString("hex");
        // 可选绑定到应用账号 (用量按账号归集)
        const accountId = String(body.account_id ?? "") || null;
        await pool.query(
          "INSERT INTO app_keys (id, app_id, key, label, account_id) VALUES ($1,$2,$3,$4,$5)",
          [id, appId, key, String(body.label ?? ""), accountId]);
        return json(res, 201, { id, key });
      }
      const delKey = path.match(/^\/app\/hall\/manage\/key\/([^/]+)$/);
      if (method === "DELETE" && delKey) {
        await pool.query("UPDATE app_keys SET revoked = true WHERE id = $1 AND app_id = $2",
          [decodeURIComponent(delKey[1]), appId]);
        return json(res, 200, { ok: true });
      }

      // LLM 配置 (管理员配置该应用用的上游: url / key / model)
      if (method === "GET" && path === "/app/hall/manage/llm") {
        const { rows } = await pool.query(
          "SELECT url, key, model FROM app_llm_config WHERE app_id = $1", [appId]);
        return json(res, 200, { llm: rows[0] ?? { url: "", key: "", model: "" } });
      }
      // 从上游拉取可用模型列表 (GET {url}/models), 支持临时覆盖 url/key
      if (method === "GET" && path === "/app/hall/manage/llm/models") {
        const qUrl = new URL(req.url ?? "/", "http://x").searchParams.get("url") ?? "";
        const qKey = new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "";
        const { rows } = await pool.query(
          "SELECT url, key FROM app_llm_config WHERE app_id = $1", [appId]);
        const url = normalizeLlmBase(qUrl || rows[0]?.url || process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4");
        const key = qKey || rows[0]?.key || process.env.BIGMODEL_API_KEY || "";
        if (!key) return json(res, 400, { error: "尚未配置 API Key" });
        try {
          const upstream = await fetch(url + "/models", {
            headers: { Authorization: "Bearer " + key },
            signal: AbortSignal.timeout(20_000),
          });
          const text = await upstream.text();
          if (!upstream.ok) return json(res, 502, { error: `上游 ${upstream.status}: ${text.slice(0, 150)}` });
          const parsed = JSON.parse(text);
          const ids = (parsed.data ?? parsed.models ?? []).map((m: any) => m.id ?? m.name ?? String(m)).filter(Boolean);
          return json(res, 200, { models: ids });
        } catch (e: any) {
          return json(res, 502, { error: "拉取失败: " + String(e?.message ?? e) });
        }
      }
      if (method === "PUT" && path === "/app/hall/manage/llm") {
        const body = await readBody(req);
        // 字段级合并: 未提供的字段保留原值 (env 与 llm 可分别保存)
        const { rows: existing } = await pool.query(
          "SELECT url, key, model, env FROM app_llm_config WHERE app_id = $1", [appId]);
        const prev = existing[0] ?? { url: "", key: "", model: "", env: {} };
        const url = body.url !== undefined ? String(body.url) : prev.url;
        const key = body.key !== undefined && body.key !== "" ? String(body.key) : prev.key;
        const model = body.model !== undefined ? String(body.model) : prev.model;
        const env = body.envText !== undefined
          ? JSON.stringify(parseEnvText(String(body.envText)))
          : JSON.stringify(prev.env ?? {});
        await pool.query(
          `INSERT INTO app_llm_config (app_id, url, key, model, env, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb, now())
           ON CONFLICT (app_id) DO UPDATE SET url=$2, key=$3, model=$4, env=$5::jsonb, updated_at=now()`,
          [appId, url, key, model, env]);
        void writeAudit(await emailOf(userId), "app.llm_save", appId,
          [body.url !== undefined ? "url" : null, body.key !== undefined && body.key !== "" ? "key" : null,
           body.model !== undefined ? "model" : null, body.envText !== undefined ? "env" : null]
            .filter(Boolean).join("/") || "(空保存)");
        return json(res, 200, { ok: true });
      }


      // 重置应用账号密码 (管理员操作)
      const resetPwd = path.match(/^\/app\/hall\/manage\/account\/([^/]+)\/reset$/);
      if (method === "POST" && resetPwd) {
        const body = await readBody(req);
        const newPassword = String(body.newPassword ?? "");
        if (newPassword.length < 4) return json(res, 400, { error: "新密码至少 4 位" });
        const hash = await hashPassword(newPassword);
        const { rowCount } = await pool.query(
          "UPDATE app_accounts SET password_hash = $1 WHERE id = $2 AND app_id = $3",
          [hash, decodeURIComponent(resetPwd[1]), appId]);
        if (rowCount === 0) return json(res, 404, { error: "账号不存在" });
        const { rows: accRow2 } = await pool.query(
          "SELECT username FROM app_accounts WHERE id = $1",
          [decodeURIComponent(resetPwd[1])]);
        void writeAudit(await emailOf(userId), "appaccount.reset", appId, accRow2[0]?.username ?? "");
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "manage: not found" });
    }

    // ── 班级协作: 创建/加入/我的班级 (需 token) ──
    const myToken = (req.headers.authorization ?? "").startsWith("Bearer ")
      ? (req.headers.authorization ?? "").slice(7) : "";
    const myId = myToken ? verifyToken(myToken) : null;
    if (path.startsWith("/app/class")) {
      if (!myId) return json(res, 401, { error: "未授权: 需要 Bearer token" });

      if (method === "GET" && path === "/app/class/mine") {
        const { rows } = await pool.query(
          `SELECT c.code, c.name, m.role FROM class_members m
           JOIN classes c ON c.code = m.class_code WHERE m.user_id = $1`,
          [myId],
        );
        return json(res, 200, { classes: rows });
      }

      if (method === "POST" && path === "/app/class/create") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) return json(res, 400, { error: "name 必填" });
        const code = randomBytes(3).toString("hex").toUpperCase(); // 6 位班级码
        await pool.query(
          "INSERT INTO classes (code, name, created_by) VALUES ($1, $2, $3)",
          [code, name, myId],
        );
        await pool.query(
          "INSERT INTO class_members (class_code, user_id, role) VALUES ($1, $2, 'owner')",
          [code, myId],
        );
        return json(res, 201, { code, name });
      }

      const joinMatch = path.match(/^\/app\/class\/join$/);
      if (method === "POST" && path === "/app/class/join") {
        const body = await readBody(req);
        const code = String(body.code ?? "").trim().toUpperCase();
        const { rows } = await pool.query("SELECT code FROM classes WHERE code = $1", [code]);
        if (rows.length === 0) return json(res, 404, { error: "班级码不存在" });
        await pool.query(
          "INSERT INTO class_members (class_code, user_id, role) VALUES ($1, $2, 'teacher') ON CONFLICT DO NOTHING",
          [code, myId],
        );
        const name = rows[0].code;
        return json(res, 200, { code, name });
      }

      if (method === "POST" && /^\/app\/class\/leave$/.test(path)) {
        const body = await readBody(req);
        const code = String(body.code ?? "").trim().toUpperCase();
        await pool.query(
          "DELETE FROM class_members WHERE class_code = $1 AND user_id = $2",
          [code, myId],
        );
        return json(res, 200, { ok: true });
      }

      // ── 班级共享数据: /app/class/:code/data/:table (成员均可读写) ──
      const cData = path.match(/^\/app\/class\/([^/]+)\/data\/([^/]+)(?:\/([^/]+))?$/);
      if (cData) {
        const code = decodeURIComponent(cData[1]).toUpperCase();
        const tableName = decodeURIComponent(cData[2]);
        const rowId = cData[3] ? decodeURIComponent(cData[3]) : null;
        const { rows: mem } = await pool.query(
          "SELECT 1 FROM class_members WHERE class_code = $1 AND user_id = $2",
          [code, myId],
        );
        if (mem.length === 0) return json(res, 403, { error: "不是该班级成员" });
        const effOwner = "class:" + code; // 班级空间: 所有成员共用一份数据

        if (method === "GET" && !rowId) {
          const { rows } = await pool.query(
            `SELECT r.id, r.data, r.created_at, r.updated_at
             FROM app_rows r JOIN app_tables t ON r.table_id = t.id
             WHERE t.owner_id = $1 AND t.table_name = $2
             ORDER BY r.created_at DESC`,
            [effOwner, tableName],
          );
          return json(res, 200, { rows });
        }
        if (method === "POST" && !rowId) {
          const body = await readBody(req);
          let tableId: string;
          const { rows: tRows } = await pool.query(
            "SELECT id FROM app_tables WHERE owner_id = $1 AND table_name = $2",
            [effOwner, tableName],
          );
          if (tRows.length === 0) {
            tableId = randomUUID();
            await pool.query(
              "INSERT INTO app_tables (id, owner_id, table_name) VALUES ($1, $2, $3)",
              [tableId, effOwner, tableName],
            );
          } else {
            tableId = tRows[0].id;
          }
          const id = randomUUID();
          await pool.query(
            "INSERT INTO app_rows (id, table_id, owner_id, data) VALUES ($1, $2, $3, $4)",
            [id, tableId, effOwner, JSON.stringify(body.data ?? {})],
          );
          return json(res, 201, { id });
        }
        if (rowId && method === "PUT") {
          const body = await readBody(req);
          const { rowCount } = await pool.query(
            `UPDATE app_rows r SET data = $3, updated_at = now()
             FROM app_tables t
             WHERE r.id = $1 AND r.table_id = t.id AND t.owner_id = $2 AND t.table_name = $4`,
            [rowId, effOwner, JSON.stringify(body.data ?? {}), tableName],
          );
          if (rowCount === 0) return json(res, 404, { error: "数据不存在" });
          return json(res, 200, { ok: true });
        }
        if (rowId && method === "DELETE") {
          const { rowCount } = await pool.query(
            `DELETE FROM app_rows r USING app_tables t
             WHERE r.id = $1 AND r.table_id = t.id AND t.owner_id = $2 AND t.table_name = $3`,
            [rowId, effOwner, JSON.stringify(null), tableName],
          );
          if (rowCount === 0) return json(res, 404, { error: "数据不存在" });
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: "method not allowed" });
      }

      return json(res, 404, { error: "app class: not found" });
    }

    // ── auth 中间件 (以下全部需要 token) ──
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const userId = token ? verifyToken(token) : null;
    if (!userId) return json(res, 401, { error: "未授权: 需要 Bearer token" });

    // ── apps 表 ──
    if (method === "GET" && path === "/app/apps") {
      const { rows } = await pool.query(
        "SELECT id, name, category, is_public, created_at, updated_at FROM apps WHERE owner_id = $1 ORDER BY created_at DESC",
        [userId],
      );
      return json(res, 200, { apps: rows });
    }

    if (method === "POST" && path === "/app/apps") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) return json(res, 400, { error: "name 必填" });
      const id = body.id && /^[a-z0-9-]{1,64}$/.test(String(body.id)) ? String(body.id) : randomUUID();
      const html = String(body.html ?? "");
      const category = String(body.category ?? "general");
      await pool.query(
        `INSERT INTO apps (id, owner_id, name, category, html, is_public)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, name, category, html, !!body.is_public],
      );
      return json(res, 201, { app: { id, name, category } });
    }

    const appMatch = path.match(/^\/app\/apps\/([^/]+)$/);
    if (appMatch) {
      const appId = decodeURIComponent(appMatch[1]);
      if (method === "GET") {
        const { rows } = await pool.query(
          "SELECT id, owner_id, name, category, html, is_public, created_at, updated_at FROM apps WHERE id = $1 AND (owner_id = $2 OR is_public)",
          [appId, userId],
        );
        if (rows.length === 0) return json(res, 404, { error: "应用不存在" });
        return json(res, 200, { app: rows[0] });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const { rowCount } = await pool.query(
          `UPDATE apps SET name = COALESCE($3, name), html = COALESCE($4, html),
           category = COALESCE($5, category), is_public = COALESCE($6, is_public),
           updated_at = now() WHERE id = $1 AND owner_id = $2`,
          [appId, userId, body.name ?? null, body.html ?? null, body.category ?? null, body.is_public ?? null],
        );
        if (rowCount === 0) return json(res, 404, { error: "应用不存在或无权修改" });
        return json(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        const { rowCount } = await pool.query(
          "DELETE FROM apps WHERE id = $1 AND owner_id = $2",
          [appId, userId],
        );
        if (rowCount === 0) return json(res, 404, { error: "应用不存在或无权删除" });
        return json(res, 200, { ok: true });
      }
    }

    // ── 应用数据 (多租户: 按 owner_id 隔离) ──
    const dataMatch = path.match(/^\/app\/data\/([^/]+)(?:\/([^/]+))?$/);
    if (dataMatch) {
      const tableName = decodeURIComponent(dataMatch[1]);
      const rowId = dataMatch[2] ? decodeURIComponent(dataMatch[2]) : null;

      // 双账号统一: 应用账号 (appacc:) 读写的数据统一挂到该应用 owner 名下,
      // 避免不同应用账号/主账号各存一份导致数据分裂 (2026-09-08 核查确认过分裂, 已迁移存量)。
      let dataOwner = userId;
      if (userId.startsWith("appacc:")) {
        const { rows: acc } = await pool.query(
          `SELECT ow.owner_id FROM app_accounts a
           LEFT JOIN apps ow ON ow.id = a.app_id
           WHERE a.id = $1`,
          [userId.slice("appacc:".length)],
        );
        if (acc[0]?.owner_id) dataOwner = acc[0].owner_id;
      }

      // 自动建表 (app_tables) + 数据行 (app_rows) 沿用现有结构
      if (method === "GET" && !rowId) {
        const { rows } = await pool.query(
          `SELECT r.id, r.data, r.created_at, r.updated_at
           FROM app_rows r JOIN app_tables t ON r.table_id = t.id
           WHERE t.owner_id = $1 AND t.table_name = $2
           ORDER BY r.created_at DESC`,
          [dataOwner, tableName],
        );
        return json(res, 200, { rows });
      }

      if (method === "POST" && !rowId) {
        const body = await readBody(req);
        // 确保 app_tables 存在
        let tableId: string;
        const { rows: tRows } = await pool.query(
          "SELECT id FROM app_tables WHERE owner_id = $1 AND table_name = $2",
          [dataOwner, tableName],
        );
        if (tRows.length === 0) {
          tableId = randomUUID();
          await pool.query(
            "INSERT INTO app_tables (id, owner_id, table_name) VALUES ($1, $2, $3)",
            [tableId, dataOwner, tableName],
          );
        } else {
          tableId = tRows[0].id;
        }
        const id = randomUUID();
        await pool.query(
          "INSERT INTO app_rows (id, table_id, owner_id, data) VALUES ($1, $2, $3, $4)",
          [id, tableId, dataOwner, JSON.stringify(body.data ?? {})],
        );
        return json(res, 201, { id });
      }

      if (rowId) {
        if (method === "PUT") {
          const body = await readBody(req);
          const { rowCount } = await pool.query(
            `UPDATE app_rows r SET data = $3, updated_at = now()
             FROM app_tables t
             WHERE r.id = $1 AND r.table_id = t.id AND t.owner_id = $2 AND t.table_name = $4`,
            [rowId, dataOwner, JSON.stringify(body.data ?? {}), tableName],
          );
          if (rowCount === 0) return json(res, 404, { error: "数据不存在" });
          return json(res, 200, { ok: true });
        }
        if (method === "DELETE") {
          const { rowCount } = await pool.query(
            `DELETE FROM app_rows r USING app_tables t
             WHERE r.id = $1 AND r.table_id = t.id AND t.owner_id = $2 AND t.table_name = $3`,
            [rowId, dataOwner, tableName],
          );
          if (rowCount === 0) return json(res, 404, { error: "数据不存在" });
          return json(res, 200, { ok: true });
        }
      }
    }

    json(res, 404, { error: `app backend: not found (${method} ${path})` });
  } catch (e: any) {
    console.error("[app-backend]", e);
    json(res, 500, { error: `服务器错误: ${String(e?.message ?? e)}` });
  }
}

// ── 初始化 ───────────────────────────────────────────────────────

/** 确保应用有一个有效网关 Key: 有则返回, 无则签发 (label=默认) */
export async function ensureAppKey(appId: string, userId: string): Promise<string> {
  // 沙箱文件应用首次访问时自动注册归属
  const own = await pool.query("SELECT id FROM apps WHERE id = $1 AND owner_id = $2", [appId, userId]);
  if (own.rows.length === 0 && /^[\w一-龥-]+\.html$/.test(appId)) {
    await pool.query(
      "INSERT INTO apps (id, owner_id, name, category, html, is_public) VALUES ($1,$2,$3,'hall','',true) ON CONFLICT DO NOTHING",
      [appId, userId, appId]);
  }
  const { rows } = await pool.query(
    "SELECT key FROM app_keys WHERE app_id = $1 AND revoked = false ORDER BY created_at LIMIT 1",
    [appId]);
  if (rows.length > 0) return rows[0].key;
  const id = randomUUID();
  const key = "sk-app-" + randomBytes(16).toString("hex");
  await pool.query(
    "INSERT INTO app_keys (id, app_id, key, label) VALUES ($1,$2,$3,'默认')",
    [id, appId, key]);
  keyCache = null; // 失效缓存
  return key;
}

/** LLM base URL 归一化: 去尾斜杠; 兼容误填完整补全路径 (.../chat/completions) */
function normalizeLlmBase(url: string): string {
  let u = url.trim().replace(/\/$/, "");
  if (u.toLowerCase().endsWith("/chat/completions")) u = u.slice(0, -"/chat/completions".length);
  return u;
}

// .env 文本 <-> 对象 (KEY=VALUE, 每行一条, # 开头为注释)
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
function envToText(env: Record<string, unknown>): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");
}

// 网关动态 Key 校验: master key 或任一未吊销的应用 Key; 30s 内存缓存
let keyCache: { keys: Set<string>; at: number } | null = null;
export async function isKnownGatewayKey(key: string): Promise<boolean> {
  if (!key) return false;
  const now = Date.now();
  if (!keyCache || now - keyCache.at > 30_000) {
    const { rows } = await pool.query(
      "SELECT key FROM app_keys WHERE revoked = false");
    keyCache = { keys: new Set(rows.map(r => r.key)), at: now };
  }
  return keyCache.keys.has(key);
}

export async function initAppBackend(): Promise<void> {
  await ensureSchema();
  // 预置已知的 DSH 插件 (不启用, 由管理员在插件管理页配置后启用)
  await pool.query(
    `INSERT INTO dsh_plugins (name, package, export_name, description, enabled, config)
     VALUES ('timem', '@timem/dsh-plugin-timem', 'timemPlugin', 'TiMEM 长期记忆 (记忆检索/写入)', false, $1::jsonb)
     ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify({ apiKey: "", baseUrl: "http://127.0.0.1:8001", defaultDomain: "appbase" })],
  );
  console.log(`AppBase 后端已就绪 (PG ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database})`);
}