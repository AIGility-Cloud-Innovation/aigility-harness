/**
 * Aigility 智悦智能平台底座 —— 复用 AppBase app-backend（examples/appbase）
 *
 * 与 fde-workbench 同一收编模式，鉴权零新造：
 *   - 账号体系: users 表 + scrypt 哈希 + HMAC token（APPBASE_TOKEN_SECRET/.token-secret
 *     与 AppBase 同源 → token 与 AppBase 全线互通，真正的账号统一）
 *   - 鉴权 API: POST /app/auth/login|register|logout · GET /app/auth/me（限流 + 审计内置）
 *   - 业务数据: /app/data/:table/:rowId?app=aigility-platform（JSONB 原语, 虚拟 owner 共享读写）
 *   - 用量计量: 网关 → POST /app/usage/collect → llm_usage 表（按网关 key 归集）
 *   - 附赠: initAppBackend 的 timem 插件配置→env 桥（内核 bootstrap 前执行, 记忆即插即用）
 *
 * aigility 侧只新增：演示账号与应用行的幂等种子 + /app/* 路由挂载。
 * 本地 /api/aigility/* 接口用 bearerUser/verifyToken 校验 AppBase 会话（见 index.ts）。
 */

import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  appBackendHandler,
  bearerUser,
  ensureAppKey,
  initAppBackend,
  pool,
} from "@aigility-harness/appbase/backend";
import { dshLoadPlugin, dshStatus, type DshPluginRecord } from "@aigility-harness/appbase/dsh-host";

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

export const AIGILITY_APP_ID = "aigility-platform";

/** 演示账号（真实 PG 平台账号；与 AppBase 共库共账号体系） */
const DEMO_ACCOUNTS = [
  { email: "admin@aigility.local", password: "admin123" },
  { email: "fde@aigility.local", password: "fde123" },
  { email: "demo@aigility.local", password: "demo123" },
];

export interface AigilityPlatform {
  /** aigility-platform 应用网关 key（持久化在 app_keys 表, 重启不变） */
  gatewayKey: string;
}

/**
 * 幂等种子：账号 → 应用行 → 成员 → 网关 key。必须在内核 bootstrap 前调用
 * （initAppBackend 内的 timem env 桥要求先于 bootstrap 执行）。
 * 需要可达的 AppBase PG（缺省 127.0.0.1:5433/appbase, APPBASE_PG_* 可覆盖）。
 */
export async function ensureAigilityPlatform(): Promise<AigilityPlatform> {
  await initAppBackend();

  // 1. 演示账号（已存在则跳过, 不覆盖 AppBase 侧的密码/管理员状态）
  let adminId = "";
  for (const acc of DEMO_ACCOUNTS) {
    const { rows: existing } = await pool.query(
      "SELECT id FROM users WHERE email = $1", [acc.email]);
    if (existing.length > 0) {
      if (acc.email === DEMO_ACCOUNTS[0].email) adminId = existing[0].id;
      continue;
    }
    const { rows: anyUser } = await pool.query("SELECT 1 FROM users LIMIT 1");
    // 库为空时 admin@aigility.local 首个建号为管理员（与 AppBase「首个注册自动管理员」一致）；
    // 库非空（AppBase 已有账号）则不抢管理员
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

  // 2. 应用行（数据 API ?app=aigility-platform 的虚拟 owner 依赖它存在）
  await pool.query(
    `INSERT INTO apps (id, owner_id, name, category, html, is_public)
     VALUES ($1,$2,'Aigility 智悦智能平台','workbench','',true)
     ON CONFLICT (id) DO NOTHING`,
    [AIGILITY_APP_ID, adminId]);

  // 3. 全部平台账号自动成为本应用成员
  await pool.query(
    `INSERT INTO app_members (app_id, user_id)
     SELECT $1, id FROM users ON CONFLICT DO NOTHING`,
    [AIGILITY_APP_ID]);

  // 3.5 任务表（平台级通用实体, 与 audit_log/credit 同级）—— 迁移幂等
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task (
      id          uuid PRIMARY KEY,
      title       text NOT NULL,
      detail      text DEFAULT '',
      executor    text NOT NULL DEFAULT 'human',
      status      text NOT NULL DEFAULT 'open',
      priority    text DEFAULT '中',
      due_at      timestamptz,
      created_by  text NOT NULL,
      result      jsonb,
      session_id  text,
      trace_id    text,
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_task_status ON task (status)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_task_created_by ON task (created_by)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_task_due ON task (due_at)");

  // 4. DSH 工具桥种子（幂等）：dsh-tools 提供 ctx.tools 服务, dsh-mcp-client
  //    把外部 MCP server 工具注册进来（公共名 mcp__<serverName>__<rawName>）。
  //    演示 server 用官方 @modelcontextprotocol/server-everything (stdio, npx 首跑拉包)。
  const dshRows: DshPluginRecord[] = [
    // dsh-tools 的激活依赖 system-prompt 服务（官方 base profile 组合同样两者同挂）
    { name: "system-prompt", package: "@deepseek-ai/dsh-system-prompt", export_name: "", description: "DSH 系统提示词服务（dsh-tools 依赖同伴）", config: { personaPrefix: "" } },
    { name: "tools", package: "@deepseek-ai/dsh-tools", export_name: "", description: "DSH 工具注册表服务 (ctx.tools)", config: {} },
    {
      name: "mcp-demo",
      package: "@deepseek-ai/dsh-mcp-client",
      export_name: "",
      description: "MCP 客户端桥 → @modelcontextprotocol/server-everything (stdio)",
      config: { transport: "stdio", serverName: "demo", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
    },
  ];
  for (const row of dshRows) {
    await pool.query(
      `INSERT INTO dsh_plugins (name, package, export_name, description, enabled, config)
       VALUES ($1,$2,$3,$4,true,$5::jsonb)
       ON CONFLICT (name) DO NOTHING`,
      [row.name, row.package, row.export_name, row.description, JSON.stringify(row.config)]);
  }
  // initAppBackend 末尾的自启先于本种子执行（首次启动装不到）——这里补装未装载的启用行（幂等）
  const status = dshStatus();
  for (const row of dshRows) {
    const loaded = status.plugins[row.name];
    if (loaded?.at || loaded?.error) continue;
    const r = await dshLoadPlugin(row);
    console.log(`[dsh] 装载 ${row.name}: ${r.ok ? "ok" : `失败 → ${r.error ?? "?"}`}`);
  }

  // 4.5 联网工具（#1 快赢）：DSH 官方 web 工具（fetch 无需 key; search 需 DEEPSEEK_API_KEY）
  await pool.query(
    `INSERT INTO dsh_plugins (name, package, export_name, description, enabled, config)
     VALUES ('web-tool','@deepseek-ai/dsh-tool-web','','DSH 网页抓取/搜索工具（search 需 DEEPSEEK_API_KEY）',true,'{"fetch":true,"searchTimeoutMs":60000}'::jsonb)
     ON CONFLICT (name) DO NOTHING`);

  // 5. 应用网关 key（持久化；前端经注入免配置）
  const gatewayKey = await ensureAppKey(AIGILITY_APP_ID, adminId);
  return { gatewayKey };
}

/**
 * Web 端口上的 /app/* 分发（鉴权 + 数据原语 + 用量收集 + 管理面）。
 * 返回 false = 非 /app/* 请求, 交给调用方继续处理（静态托管等）。
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

/** AppBase 会话校验（本示例 /api/aigility/* 用）：Bearer token → 用户 id, 无效返回 null */
export function sessionUserId(req: IncomingMessage): string | null {
  return bearerUser(req);
}

/** 平台成员（真）：users × app_members（本应用全部平台账号） */
export async function listTeamMembers(): Promise<Array<{ email: string; isAdmin: boolean; createdAt?: string }>> {
  const { rows } = await pool.query(
    `SELECT u.email, u.is_admin, u.created_at
     FROM app_members m JOIN users u ON u.id = m.user_id
     WHERE m.app_id = $1 ORDER BY u.created_at ASC`,
    [AIGILITY_APP_ID]);
  return rows.map((r: any) => ({ email: r.email, isAdmin: !!r.is_admin, createdAt: r.created_at }));
}

/** 审计日志（真）：AppBase writeAudit 双写内存环 + PG audit_log（登录/管理操作留痕） */
export async function recentAudit(limit = 20): Promise<Array<{ at: string; actor: string; action: string; target: string; detail: string }>> {
  try {
    const { rows } = await pool.query(
      "SELECT created_at, actor, action, target, detail FROM audit_log ORDER BY created_at DESC LIMIT $1",
      [limit]);
    return rows.map((r: any) => ({
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      actor: r.actor, action: r.action, target: r.target, detail: r.detail,
    }));
  } catch {
    return [];
  }
}

/** 会话用户 id → 邮箱（credit/计量按邮箱归集） */
export async function emailById(userId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
  return rows[0]?.email ?? null;
}

// ── 任务表（真表, 平台级通用实体）────────────────────────────────

export interface TaskRow {
  id: string;
  title: string;
  detail: string;
  executor: string;
  status: string;
  priority: string;
  dueAt: string | null;
  createdBy: string;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

function mapTask(r: any): TaskRow {
  return {
    id: r.id, title: r.title, detail: r.detail ?? "", executor: r.executor,
    status: r.status, priority: r.priority ?? "中",
    dueAt: r.due_at ?? null, createdBy: r.created_by,
    result: r.result ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function createTask(t: { title: string; detail?: string; executor: string; priority?: string; createdBy: string }): Promise<TaskRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO task (id, title, detail, executor, status, priority, created_by)
     VALUES ($1,$2,$3,$4,'open',$5,$6) RETURNING *`,
    [id, t.title, t.detail ?? "", t.executor, t.priority ?? "中", t.createdBy]);
  return mapTask(rows[0]);
}

export async function listTasks(opts?: { status?: string; createdBy?: string; limit?: number }): Promise<TaskRow[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts?.status) { args.push(opts.status); conds.push(`status = $${args.length}`); }
  if (opts?.createdBy) { args.push(opts.createdBy); conds.push(`created_by = $${args.length}`); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  args.push(opts?.limit ?? 100);
  const { rows } = await pool.query(
    `SELECT * FROM task ${where} ORDER BY created_at DESC LIMIT $${args.length}`, args);
  return rows.map(mapTask);
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const { rows } = await pool.query("SELECT * FROM task WHERE id = $1", [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

/** CAS 状态流转：仅在当前状态匹配期望值时更新（timem-project 同款语义），可附带产出物 */
export async function transitionTask(id: string, from: string, to: string, result?: unknown): Promise<TaskRow | null> {
  const { rows } = await pool.query(
    `UPDATE task SET status = $2, result = COALESCE($3::jsonb, result), updated_at = now()
     WHERE id = $1 AND status = $4 RETURNING *`,
    [id, to, result !== undefined ? JSON.stringify(result) : null, from]);
  return rows[0] ? mapTask(rows[0]) : null;
}
