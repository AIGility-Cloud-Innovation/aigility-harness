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
import { updateModelsUpstream } from "@aigility-harness/layer-infrastructure";
import { dshLoadPlugin, dshLoadEnabled, dshStatus } from "./dsh-host.js";
// ── Admin modules (管理界面插件化): 原语迁至 admin-modules/context, 路由迁至各模块 ──
import {
  json, readBody, pool, hashPassword, verifyPassword, signToken, setAuthCookie,
  bearerUser, verifyToken, isAdminUser, writeAudit, emailOf, loginLimiter, loginLockKey,
  pageUserId, PG_CONFIG,
} from "./admin-modules/context.js";
import { adminDispatch, adminPanelList } from "./admin-modules/index.js";
import { initLlmConfig, normalizeLlmBase } from "./admin-modules/llm-config.js";
import { httpRelayProvider, relayTargets } from "@aigility-harness/layer-infrastructure";
import { parseEnvText } from "./admin-modules/context.js";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// ── PG 连接 ──────────────────────────────────────────────────────
// 已迁至 admin-modules/context.ts (管理界面插件化); pool/PG_CONFIG 经下方 re-export 提供。

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
    ALTER TABLE app_llm_config ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS chat_history (
      user_id    TEXT NOT NULL,
      conv_key   TEXT NOT NULL,
      messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, conv_key)
    );
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
    // ── 管理模块优先分发 (管理界面插件化: users/llm-config/dsh/harness-plugins) ──
    if (await adminDispatch(req, res, path, method)) return;

    // ── 数据转发 (L1 @infrastructure/http-relay 具名目标): 沙箱应用同源读取无 CORS 数据源 ──
    const relayMatch = path.match(/^\/app\/relay\/([^/]+)$/);
    if (relayMatch && method === "GET") {
      const name = decodeURIComponent(relayMatch[1]);
      const query = url.searchParams.toString();
      // 目标解析: Referer 识别来源应用 → 该应用 .env 的 RELAY_<NAME> 优先, 回落全局 env
      let relayBase: string | undefined;
      const refApp = /\/app\/hall\/apps\/([^/?#]+\.html)/.exec(String(req.headers.referer ?? ""))?.[1];
      if (refApp) {
        const { rows: envRows } = await pool.query(
          "SELECT env FROM app_llm_config WHERE app_id = $1", [refApp]);
        const envCfg = (envRows[0]?.env ?? {}) as Record<string, unknown>;
        const v = envCfg["RELAY_" + name.toUpperCase()];
        if (typeof v === "string" && /^https?:\/\//.test(v)) relayBase = v;
      }
      const relay = await httpRelayProvider.execute(
        { name, query: query || undefined, baseUrl: relayBase },
        { sessionId: "relay", traceId: "relay", callerLayer: 1, addEffect: () => "e", emit: () => {}, getState: () => undefined, setState: () => {}, call: (() => { throw new Error("relay ctx 不支持 call"); }) } as never,
      );
      if (!relay.ok) return json(res, 400, { error: relay.error });
      res.writeHead(200, { "Content-Type": relay.value.contentType || "text/plain; charset=utf-8" });
      res.end(relay.value.body);
      return;
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

    // ── 应用 .env 读取 (账号统一改造: 平台账号身份, Bearer 或 cookie 双轨) ──
    if (method === "GET" && path === "/app/hall/appauth/env") {
      const uid = pageUserId(req);
      if (!uid) return json(res, 401, { error: "未授权: 请先登录" });
      const envApp = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      const { rows } = await pool.query(
        "SELECT env FROM app_llm_config WHERE app_id = $1", [envApp]);
      return json(res, 200, { env: rows[0]?.env ?? {} });
    }

    // ── LLM 代理: 应用凭平台账号身份调用 (Bearer 或 cookie), 上游配置存服务端 (Key 不出后端) ──
    if (method === "POST" && path === "/app/hall/llm") {
      const subject = pageUserId(req);
      if (!subject) return json(res, 401, { error: "未授权: 请先登录" });
      const body = await readBody(req);
      const llmAppId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      // 应用访问权: owner ∪ 成员 ∪ 管理员
      if (llmAppId) {
        const { rows: appRow } = await pool.query("SELECT owner_id FROM apps WHERE id = $1", [llmAppId]);
        if (appRow.length === 0) return json(res, 404, { error: "应用不存在: " + llmAppId });
        const isOwner = appRow[0].owner_id === subject;
        const isMember = !isOwner
          ? (await pool.query("SELECT 1 FROM app_members WHERE app_id = $1 AND user_id = $2", [llmAppId, subject])).rowCount! > 0
          : false;
        if (!isOwner && !isMember && !(await isAdminUser(subject))) {
          return json(res, 403, { error: "你没有该应用的访问权限" });
        }
      }
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
    // ── 成员候选: 注册账号邮箱清单 (owner/admin 为应用添加成员时下拉选择) ──
    if (method === "GET" && path === "/app/hall/manage/user-emails") {
      const mu = pageUserId(req) ?? bearerUser(req);
      if (!mu) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(mu))) {
        // 非管理员须为某应用 owner 才能取候选
        const { rows: own } = await pool.query(
          "SELECT 1 FROM apps WHERE owner_id = $1 LIMIT 1", [mu]);
        if (own.length === 0) return json(res, 403, { error: "需要管理员或应用创建者身份" });
      }
      const { rows } = await pool.query("SELECT email FROM users ORDER BY email");
      return json(res, 200, { emails: rows.map((r: any) => r.email) });
    }

    // ── 聊天历史云端持久化 (登录用户级: 退出/换浏览器/清本地存储都不丢) ──
    if (path === "/app/hall/chat-history") {
      const auth = req.headers.authorization ?? "";
      const userId = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
      if (!userId) return json(res, 401, { error: "未授权: 请先登录" });
      if (method === "GET") {
        const convKey = String(new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "");
        if (!convKey) return json(res, 400, { error: "缺少 key" });
        const { rows } = await pool.query(
          "SELECT messages FROM chat_history WHERE user_id = $1 AND conv_key = $2", [userId, convKey]);
        return json(res, 200, { messages: rows[0]?.messages ?? [] });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const convKey = String(body.key ?? "");
        const msgs = Array.isArray(body.messages) ? body.messages.slice(-60) : [];
        if (!convKey) return json(res, 400, { error: "缺少 key" });
        await pool.query(
          `INSERT INTO chat_history (user_id, conv_key, messages, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (user_id, conv_key) DO UPDATE SET messages=$3::jsonb, updated_at=now()`,
          [userId, convKey, JSON.stringify(msgs)]);
        return json(res, 200, { ok: true });
      }
    }

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

      const userId = pageUserId(req);
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

    // ── auth 中间件 (以下全部需要 token; /app/data 除外 —— 数据路由内做 Bearer/cookie 双轨鉴权) ──
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const userId = token ? verifyToken(token) : null;
    if (!userId && !path.startsWith("/app/data/")) {
      return json(res, 401, { error: "未授权: 需要 Bearer token" });
    }

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

    // ── 应用数据 (账号统一改造: 数据归属应用虚拟 owner `app:<appId>`, 授权成员共享读写) ──
    const dataMatch = path.match(/^\/app\/data\/([^/]+)(?:\/([^/]+))?$/);
    if (dataMatch) {
      const tableName = decodeURIComponent(dataMatch[1]);
      const rowId = dataMatch[2] ? decodeURIComponent(dataMatch[2]) : null;
      // 双轨身份: Bearer 或 httpOnly cookie (应用新标签页靠 cookie; 上方 auth 中间件仅认 Bearer, 此处重取)
      const dataUid = pageUserId(req) ?? userId;
      if (!dataUid) return json(res, 401, { error: "未授权: 请先登录" });

      // 应用归属: 带 ?app=<appId> 的请求 → 数据挂 `app:<appId>` (成员共享, 参照 class: 虚拟 owner 先例);
      // 未带 app → 按用户隔离 (兼容班级等旧链路)
      const dataAppId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
      let dataOwner: string;
      if (dataAppId) {
        // 应用访问权: owner ∪ 成员 ∪ 管理员
        const { rows: appRow } = await pool.query("SELECT owner_id FROM apps WHERE id = $1", [dataAppId]);
        if (appRow.length === 0) return json(res, 404, { error: "应用不存在: " + dataAppId });
        const isOwner = appRow[0].owner_id === dataUid;
        const isMember = !isOwner
          ? (await pool.query("SELECT 1 FROM app_members WHERE app_id = $1 AND user_id = $2", [dataAppId, dataUid])).rowCount! > 0
          : false;
        if (!isOwner && !isMember && !(await isAdminUser(dataUid))) {
          return json(res, 403, { error: "你没有该应用的访问权限, 请联系管理员或应用创建者添加" });
        }
        dataOwner = "app:" + dataAppId;
      } else {
        dataOwner = dataUid;
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

// .env 文本 <-> 对象 (KEY=VALUE, 每行一条, # 开头为注释)
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
  // 积分账务换装 PG (首笔扣费前; 内存账本仅零依赖原型兜底) —— 钱必须持久
  const { configureCreditStore } = await import("@aigility-harness/layer-infrastructure");
  configureCreditStore({ pool });
  // 预置已知的 DSH 插件 (不启用, 由管理员在插件管理页配置后启用)
  await pool.query(
    `INSERT INTO dsh_plugins (name, package, export_name, description, enabled, config)
     VALUES ('timem', '@timem/dsh-plugin-timem', 'timemPlugin', 'TiMEM 长期记忆 (记忆检索/写入)', false, $1::jsonb)
     ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify({ apiKey: "", baseUrl: "http://127.0.0.1:8001", defaultDomain: "appbase" })],
  );
  // DSH 插件配置 → 认知能力环境变量桥: timem 的 apiKey/baseUrl 存在 dsh_plugins 表,
  // 未显式设置环境变量时灌入, 让 @cognitive/timem-memory 直接可用
  // (必须在内核 bootstrap 前执行 —— 本函数的调用时机即满足)。
  // 注意: 管理页改配置后需重启服务才能刷新到这里。
  try {
    const { rows } = await pool.query("SELECT config FROM dsh_plugins WHERE name = 'timem'");
    const cfg = (rows[0]?.config ?? {}) as Record<string, unknown>;
    if (!process.env.TIMEM_API_KEY && cfg.apiKey) process.env.TIMEM_API_KEY = String(cfg.apiKey);
    if (!process.env.TIMEM_BASE_URL && cfg.baseUrl) process.env.TIMEM_BASE_URL = String(cfg.baseUrl);
    if (!process.env.TIMEM_DEFAULT_DOMAIN && cfg.defaultDomain) process.env.TIMEM_DEFAULT_DOMAIN = String(cfg.defaultDomain);
  } catch { /* 无 timem 行不影响启动 */ }

  // 全局 LLM 平台配置: 种子/应用逻辑在 admin-modules/llm-config.ts (管理界面插件化)
  await initLlmConfig();

  // 账号统一改造存量迁移 (2026-09-12): /app/data 归属从用户改为应用虚拟 owner `app:<appId>`。
  // teacher-notebook 是当前唯一按应用存数据的消费者(表名 notebook); 其 owner 名下同名表迁到 app: 前缀。
  // 迁移幂等: app: 前缀的行不会重复匹配。
  try {
    const { rows: hallApps } = await pool.query(
      "SELECT id, owner_id FROM apps WHERE category = 'hall' AND id = 'teacher-notebook.html'");
    for (const app of hallApps) {
      await pool.query(
        `UPDATE app_tables SET owner_id = $1
         WHERE owner_id = $2 AND table_name = 'notebook'
           AND owner_id NOT LIKE 'app:%'`,
        ["app:" + app.id, app.owner_id]);
    }
    console.log("[migrate] 应用数据归属已迁移至 app:<appId> 虚拟 owner");
  } catch (e) {
    console.error("[migrate] 应用数据归属迁移失败(忽略):", e);
  }

  // 数据转发目标种子: 全局 APPBASE_RELAY_TARGETS 里的目标写入对应应用 .env (用户可在管理抽屉改)
  try {
    for (const [tName, tUrl] of Object.entries(relayTargets())) {
      await pool.query(
        `INSERT INTO app_llm_config (app_id, url, key, model, env, updated_at)
         VALUES ($1, '', '', '', $2::jsonb, now())
         ON CONFLICT (app_id) DO UPDATE SET env = $2::jsonb, updated_at = now()`,
        [`${tName}.html`, JSON.stringify({ ["RELAY_" + tName.toUpperCase()]: tUrl })]);
    }
  } catch (e) {
    console.error("[relay] target env seed failed(忽略):", e);
  }
  console.log(`AppBase 后端已就绪 (PG ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database})`);
}
// ── 兼容 re-export: 原语已迁至 admin-modules/context.ts (管理界面插件化) ──
export {
  verifyToken, bearerUser, pageUserId, isAdminUser, writeAudit, emailOf,
  setAuthCookie, loginLockKey, pool, PG_CONFIG, parseEnvText,
} from "./admin-modules/context.js";
