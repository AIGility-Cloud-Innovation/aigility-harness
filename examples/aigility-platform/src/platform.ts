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

  // 3.5 模块装配（真 · platform-module-plugin-design Phase 0）：装配状态 + 预设模板
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_modules (
      scope      TEXT NOT NULL DEFAULT 'platform',
      module_id  TEXT NOT NULL,
      enabled    BOOLEAN NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, module_id)
    )`);
  // 3.5 导航可见偏好（per-user，多端一致）：默认隐藏集见 DEFAULT_NAV_HIDDEN，
  //     用户显式切换后落库覆盖默认（app_modules 是装配态，导航位是用户偏好，分表）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_module_nav (
      user_id    TEXT NOT NULL,
      module_id  TEXT NOT NULL,
      hidden     BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, module_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_module_presets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      enabled_ids JSONB NOT NULL,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(
    `INSERT INTO app_module_presets (id, name, enabled_ids, created_by)
     VALUES ('default', '智悦默认', $1::jsonb, 'system')
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(Object.keys(SERVER_MODULE_META).filter((id) => SERVER_MODULE_META[id].available !== false))]);

  // 3.6 数字员工对话偏好（per-user）：模型 / 思考等级 / 本地工作区——
  //     对话页三件套（模型设置 · 思考等级 · 工作区选择）的持久化事实源
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_prefs (
      user_id    TEXT PRIMARY KEY,
      model      TEXT NOT NULL DEFAULT '',
      thinking   TEXT NOT NULL DEFAULT 'auto',
      workspace  TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

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
export async function listTeamMembers(): Promise<Array<{ userId: string; email: string; isAdmin: boolean; createdAt?: string }>> {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.is_admin, u.created_at
     FROM app_members m JOIN users u ON u.id = m.user_id
     WHERE m.app_id = $1 ORDER BY u.created_at ASC`,
    [AIGILITY_APP_ID]);
  return rows.map((r: any) => ({ userId: r.id, email: r.email, isAdmin: !!r.is_admin, createdAt: r.created_at }));
}

/** 管理员判定（RBAC 模块就绪前的过渡实现：直接读 users.is_admin） */
export async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [userId]);
    return !!rows[0]?.is_admin;
  } catch {
    return false;
  }
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

// ── 模块装配（真 · 装配状态/预设持久化；manifest 本体在前端 app/src/modules/registry.ts）──

/** 服务端只留装配校验标志（core 不可关 / available 可订阅）；名称、描述、图标归前端 manifest */
export const SERVER_MODULE_META: Record<string, { core?: boolean; available?: boolean }> = {
  workspace: {}, agent: { core: true }, market: {}, apps: {}, studio: {}, tasks: { core: true },
  ingest: { core: true }, graph: {}, space: {}, process: {},
  tools: {}, models: {}, ops: {}, orchestration: {}, "task-loop": {}, "team-memory": {}, "log-monitor": {},
  monitor: { available: false }, report: { available: false }, approval: { available: false },
};

/** 装配状态 = 全部可用模块缺省开 ∪ DB 覆盖行（DB 无行时取缺省，对齐 App.tsx 原行为） */
export async function listModuleState(): Promise<Record<string, boolean>> {
  const state: Record<string, boolean> = {};
  for (const [id, meta] of Object.entries(SERVER_MODULE_META)) state[id] = meta.available !== false;
  try {
    const { rows } = await pool.query("SELECT module_id, enabled FROM app_modules WHERE scope = 'platform'");
    for (const r of rows) state[r.module_id] = !!r.enabled;
  } catch {
    // PG 不可用 → 缺省装配
  }
  return state;
}

/** 返回 null = 成功；字符串 = 拒绝原因（未知模块 / core / 未上线） */
export async function setModuleState(id: string, enabled: boolean, by: string): Promise<string | null> {
  const meta = SERVER_MODULE_META[id];
  if (!meta) return `未知模块 ${id}`;
  if (meta.core) return `核心模块 ${id} 不可关闭`;
  if (meta.available === false) return `模块 ${id} 未上线（可订阅）`;
  await pool.query(
    `INSERT INTO app_modules (scope, module_id, enabled, updated_by, updated_at)
     VALUES ('platform', $1, $2, $3, now())
     ON CONFLICT (scope, module_id) DO UPDATE SET enabled = $2, updated_by = $3, updated_at = now()`,
    [id, enabled, by]);
  return null;
}

// ── 导航可见偏好（per-user · user_module_nav；默认隐藏集 + 用户覆盖行）──

/** 默认不占导航位的工具类模块（用户可在应用中心/装配页/配置页切换，落库后多端一致） */
export const DEFAULT_NAV_HIDDEN = new Set(["team-memory", "log-monitor"]);

/** 用户导航隐藏集 = DEFAULT_NAV_HIDDEN ∪ 用户覆盖行（显式 false 即收回默认） */
export async function listNavHidden(userId: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const id of DEFAULT_NAV_HIDDEN) out[id] = true;
  try {
    const { rows } = await pool.query(
      "SELECT module_id, hidden FROM user_module_nav WHERE user_id = $1", [userId]);
    for (const r of rows) out[r.module_id] = !!r.hidden;
  } catch {
    // PG 不可用 → 仅默认集
  }
  return out;
}

/** 返回 null = 成功；字符串 = 拒绝原因（未知模块） */
export async function setNavHidden(userId: string, moduleId: string, hidden: boolean): Promise<string | null> {
  if (!SERVER_MODULE_META[moduleId]) return `未知模块 ${moduleId}`;
  await pool.query(
    `INSERT INTO user_module_nav (user_id, module_id, hidden, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, module_id) DO UPDATE SET hidden = $3, updated_at = now()`,
    [userId, moduleId, hidden]);
  return null;
}

// ── 数字员工对话偏好（per-user · chat_prefs；模型/思考等级/工作区三件套）──

export interface ChatPrefs {
  /** 请求级模型（'' = 跟随平台统一上游 / 技能偏好）；值来自网关模型池 */
  model: string;
  /** 思考等级：auto（跟随模型默认）| off | low | medium | high */
  thinking: string;
  /** 本地工作区绝对路径（'' = 未选择；服务端校验过存在且为目录） */
  workspace: string;
  updatedAt: string;
}

export const THINKING_LEVELS = ["auto", "off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/** 读取用户对话偏好（缺行返回默认：全部跟随平台） */
export async function getChatPrefs(userId: string): Promise<ChatPrefs> {
  const def: ChatPrefs = { model: "", thinking: "auto", workspace: "", updatedAt: "" };
  try {
    const { rows } = await pool.query(
      "SELECT model, thinking, workspace, updated_at FROM chat_prefs WHERE user_id = $1", [userId]);
    if (rows[0]) {
      return {
        model: typeof rows[0].model === "string" ? rows[0].model : "",
        thinking: isThinkingLevel(rows[0].thinking) ? rows[0].thinking : "auto",
        workspace: typeof rows[0].workspace === "string" ? rows[0].workspace : "",
        updatedAt: rows[0].updated_at ? String(rows[0].updated_at) : "",
      };
    }
  } catch {
    // PG 不可用 → 默认偏好
  }
  return def;
}

/** 保存用户对话偏好（upsert，入审计由调用方负责） */
export async function saveChatPrefs(
  userId: string,
  prefs: { model?: string; thinking?: string; workspace?: string },
): Promise<ChatPrefs> {
  const cur = await getChatPrefs(userId);
  const model = typeof prefs.model === "string" ? prefs.model.slice(0, 200) : cur.model;
  const thinking = isThinkingLevel(prefs.thinking) ? prefs.thinking : cur.thinking;
  const workspace = typeof prefs.workspace === "string" ? prefs.workspace.slice(0, 2000) : cur.workspace;
  try {
    await pool.query(
      `INSERT INTO chat_prefs (user_id, model, thinking, workspace, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         model = $2, thinking = $3, workspace = $4, updated_at = now()`,
      [userId, model, thinking, workspace]);
  } catch {
    // PG 不可用 → 仅内存侧保存（调用方按返回值展示）
  }
  return { ...cur, model, thinking, workspace, updatedAt: new Date().toISOString() };
}

export interface NavPrefRow {
  userId: string;
  email: string;
  isAdmin: boolean;
  navHidden: Record<string, boolean>;
}

/** 管理员视图：全部平台成员的导航偏好（管理端逐用户调整用） */
export async function listNavPrefs(): Promise<NavPrefRow[]> {
  const members = await listTeamMembers();
  return Promise.all(members.map(async (m) => ({
    userId: m.userId, email: m.email, isAdmin: m.isAdmin,
    navHidden: await listNavHidden(m.userId),
  })));
}

export interface ModulePreset {
  id: string;
  name: string;
  enabledIds: string[];
  createdBy?: string;
  createdAt?: string;
}

export async function listModulePresets(): Promise<ModulePreset[]> {
  const { rows } = await pool.query(
    "SELECT id, name, enabled_ids, created_by, created_at FROM app_module_presets ORDER BY created_at");
  return rows.map((r: any) => ({
    id: r.id, name: r.name, enabledIds: Array.isArray(r.enabled_ids) ? r.enabled_ids : [],
    createdBy: r.created_by, createdAt: r.created_at,
  }));
}

export async function saveModulePreset(name: string, enabledIds: string[], by: string): Promise<ModulePreset> {
  const id = `preset-${Date.now().toString(36)}`;
  await pool.query(
    "INSERT INTO app_module_presets (id, name, enabled_ids, created_by) VALUES ($1,$2,$3::jsonb,$4)",
    [id, name, JSON.stringify(enabledIds), by]);
  return { id, name, enabledIds, createdBy: by };
}

/** 套用预设 = 完整工作台形态替换：预设内的可用模块开、预设外的可用模块关（core 不动） */
export async function applyModulePreset(id: string, by: string): Promise<number> {
  const { rows } = await pool.query("SELECT enabled_ids FROM app_module_presets WHERE id = $1", [id]);
  const wanted = new Set<string>(
    Array.isArray(rows[0]?.enabled_ids) ? rows[0].enabled_ids.filter((x: unknown) => typeof x === "string") : [],
  );
  let changed = 0;
  for (const [mid, meta] of Object.entries(SERVER_MODULE_META)) {
    if (meta.core) continue;
    const next = meta.available !== false && wanted.has(mid);
    await pool.query(
      `INSERT INTO app_modules (scope, module_id, enabled, updated_by, updated_at)
       VALUES ('platform', $1, $2, $3, now())
       ON CONFLICT (scope, module_id) DO UPDATE SET enabled = $2, updated_by = $3, updated_at = now()`,
      [mid, next, by]);
    changed++;
  }
  return changed;
}

export async function deleteModulePreset(id: string): Promise<boolean> {
  if (id === "default") return false;
  const r = await pool.query("DELETE FROM app_module_presets WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

// ── 工具插件（dsh_plugins 注册表的读写辅助；热装卸在 index.ts 调 dsh-host）──

export interface DshPluginRow {
  name: string;
  package: string;
  exportName: string;
  description: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  createdAt?: string;
}

export async function listDshPluginRows(): Promise<DshPluginRow[]> {
  const { rows } = await pool.query(
    "SELECT name, package, export_name, description, enabled, config, created_at FROM dsh_plugins ORDER BY created_at");
  return rows.map((r: any) => ({
    name: r.name, package: r.package, exportName: r.export_name ?? "", description: r.description ?? "",
    enabled: !!r.enabled, config: r.config ?? {},
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
  }));
}

/** 返回 null = 成功；字符串 = 拒绝原因（重名等） */
export async function insertDshPlugin(row: DshPluginRow): Promise<string | null> {
  try {
    await pool.query(
      `INSERT INTO dsh_plugins (name, package, export_name, description, enabled, config)
       VALUES ($1,$2,$3,$4,true,$5::jsonb)`,
      [row.name, row.package, row.exportName, row.description, JSON.stringify(row.config)]);
    return null;
  } catch (e) {
    const msg = String(e);
    return msg.includes("duplicate key") ? `插件 ${row.name} 已存在` : msg;
  }
}

export async function setDshPluginEnabled(name: string, enabled: boolean): Promise<void> {
  await pool.query("UPDATE dsh_plugins SET enabled = $2 WHERE name = $1", [name, enabled]);
}

export async function deleteDshPluginRow(name: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM dsh_plugins WHERE name = $1", [name]);
  return (r.rowCount ?? 0) > 0;
}

/** 网关用量聚合（PG llm_usage：网关每次完成上报 /app/usage/collect 持久, 口径=网关全量）。
 *  日键取 UTC（对齐内存账本 byDay 与前端 inRange 的 toISOString 口径）。
 *  返回 null = PG 不可用或表为空（调用方回退内存账本, 保留会话内即时数据）。 */
export async function usageSummaryFromPg(): Promise<{
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel: Array<{ key: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
  byDay: Array<{ key: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
} | null> {
  const dayExpr = "(created_at AT TIME ZONE 'UTC')::date::text";
  const agg = `COUNT(*)::int AS calls, COALESCE(SUM(prompt_tokens),0)::int AS "promptTokens",
                COALESCE(SUM(completion_tokens),0)::int AS "completionTokens",
                COALESCE(SUM(total_tokens),0)::int AS "totalTokens"`;
  try {
    const { rows: byDay } = await pool.query(
      `SELECT ${dayExpr} AS key, ${agg} FROM llm_usage GROUP BY 1 ORDER BY 1`);
    if (!byDay.length) return null;
    const { rows: byModel } = await pool.query(
      `SELECT model AS key, ${agg} FROM llm_usage GROUP BY 1 ORDER BY "totalTokens" DESC`);
    const sum = (f: string) => byDay.reduce((s: number, r: any) => s + Number(r[f] ?? 0), 0);
    return {
      calls: sum("calls"),
      promptTokens: sum("promptTokens"),
      completionTokens: sum("completionTokens"),
      totalTokens: sum("totalTokens"),
      byModel,
      byDay,
    };
  } catch {
    return null;
  }
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
