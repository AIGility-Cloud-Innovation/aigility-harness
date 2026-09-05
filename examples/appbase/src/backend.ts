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
import pg from "pg";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// ── PG 连接 ──────────────────────────────────────────────────────
// 连接信息来自环境变量 (APPBASE_PG_*) 或默认本机独立 PG 5433 appbase 库。
// 密码不硬编码: 读 PGPASSWORD / APPBASE_PG_PASSWORD。

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

const SALT = "appbase-v1"; // scrypt 盐 (固定, 配合长随机 token)

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

function signToken(userId: string): string {
  // 自签名 token: userId.random.secretHash (无第三方依赖)
  const secret = process.env.APPBASE_TOKEN_SECRET ?? SALT;
  const payload = `${userId}.${randomBytes(24).toString("hex")}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token: string): string | null {
  const secret = process.env.APPBASE_TOKEN_SECRET ?? SALT;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
  return parts[0]; // userId
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
    if (method === "POST" && path === "/app/auth/register") {
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email || password.length < 6) {
        return json(res, 400, { error: "email 和 password(≥6位) 必填" });
      }
      const id = randomUUID();
      const hash = await hashPassword(password);
      try {
        await pool.query(
          "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
          [id, email, hash],
        );
      } catch (e: any) {
        if (String(e?.code) === "23505") return json(res, 409, { error: "邮箱已注册" });
        throw e;
      }
      const token = signToken(id);
      return json(res, 201, { token, user: { id, email } });
    }

    if (method === "POST" && path === "/app/auth/login") {
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const { rows } = await pool.query(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        [email],
      );
      if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
        return json(res, 401, { error: "邮箱或密码错误" });
      }
      const token = signToken(rows[0].id);
      return json(res, 200, { token, user: { id: rows[0].id, email: rows[0].email } });
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

      // 自动建表 (app_tables) + 数据行 (app_rows) 沿用现有结构
      if (method === "GET" && !rowId) {
        const { rows } = await pool.query(
          `SELECT r.id, r.data, r.created_at, r.updated_at
           FROM app_rows r JOIN app_tables t ON r.table_id = t.id
           WHERE t.owner_id = $1 AND t.table_name = $2
           ORDER BY r.created_at DESC`,
          [userId, tableName],
        );
        return json(res, 200, { rows });
      }

      if (method === "POST" && !rowId) {
        const body = await readBody(req);
        // 确保 app_tables 存在
        let tableId: string;
        const { rows: tRows } = await pool.query(
          "SELECT id FROM app_tables WHERE owner_id = $1 AND table_name = $2",
          [userId, tableName],
        );
        if (tRows.length === 0) {
          tableId = randomUUID();
          await pool.query(
            "INSERT INTO app_tables (id, owner_id, table_name) VALUES ($1, $2, $3)",
            [tableId, userId, tableName],
          );
        } else {
          tableId = tRows[0].id;
        }
        const id = randomUUID();
        await pool.query(
          "INSERT INTO app_rows (id, table_id, owner_id, data) VALUES ($1, $2, $3, $4)",
          [id, tableId, userId, JSON.stringify(body.data ?? {})],
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
            [rowId, userId, JSON.stringify(body.data ?? {}), tableName],
          );
          if (rowCount === 0) return json(res, 404, { error: "数据不存在" });
          return json(res, 200, { ok: true });
        }
        if (method === "DELETE") {
          const { rowCount } = await pool.query(
            `DELETE FROM app_rows r USING app_tables t
             WHERE r.id = $1 AND r.table_id = t.id AND t.owner_id = $2 AND t.table_name = $3`,
            [rowId, userId, tableName],
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

export async function initAppBackend(): Promise<void> {
  await ensureSchema();
  console.log(`AppBase 后端已就绪 (PG ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database})`);
}