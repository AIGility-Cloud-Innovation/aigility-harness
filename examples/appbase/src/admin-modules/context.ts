/**
 * Admin modules 共享上下文: PG 连接 + 鉴权/审计原语。
 * 从 backend.ts 迁出 (管理界面插件化); backend.ts re-export 保持兼容。
 */
import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { createMemoryRateLimiter, createMemoryAuditLog } from "@aigility-harness/layer-infrastructure";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// ── PG 连接 (与 backend.ts 原配置一致) ──
export const PG_CONFIG = {
  host: process.env.APPBASE_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.APPBASE_PG_PORT ?? 5433),
  database: process.env.APPBASE_PG_DATABASE ?? "appbase",
  user: process.env.APPBASE_PG_USER ?? "postgres",
  password: process.env.APPBASE_PG_PASSWORD ?? process.env.PGPASSWORD ?? "",
};

export const pool = new pg.Pool(PG_CONFIG);

/** 请求体读取 / JSON 响应 (原 backend.ts 内部助手) */
export function readBody(req: IncomingMessage): Promise<any> {
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

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 密码哈希 (scrypt) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const hash = await scryptAsync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hashHex, "hex"), hash);
}

/** token 有效期 (毫秒): 默认 7 天 */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getTokenSecret(): string {
  const fromEnv = process.env.APPBASE_TOKEN_SECRET;
  if (fromEnv) return fromEnv;
  const secretFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".token-secret");
  try {
    const existing = readFileSync(secretFile, "utf8").trim();
    if (existing) return existing;
  } catch { /* 首次运行, 文件不存在 */ }
  const generated = randomBytes(32).toString("hex");
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export function signToken(userId: string): string {
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

/** 管理员邮箱白名单 (环境变量 APPBASE_ADMIN_EMAILS, 逗号分隔; 与 users.is_admin 取并集) */
export function adminEmails(): string[] {
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
 * 仅用于 HTML 页面门禁; API 一律走 bearerUser。
 */
export function pageUserId(req: { headers: { authorization?: string | string[]; cookie?: string } }): string | null {
  const viaHeader = bearerUser(req);
  if (viaHeader) return viaHeader;
  const m = /(?:^|;\s*)hall_token=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m ? verifyToken(decodeURIComponent(m[1])) : null;
}

/** 给登录/注册响应签发 httpOnly cookie (页面导航门禁用) */
export function setAuthCookie(res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie",
    `hall_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
}

// ── 登录限流 / 审计 ──
export const loginLimiter = createMemoryRateLimiter({ maxFails: 5, lockMs: 15 * 60 * 1000 });
export const auditRing = createMemoryAuditLog();

export function loginLockKey(req: { socket?: { remoteAddress?: string } }, email: string): string {
  return `${req.socket?.remoteAddress ?? "unknown"}|${email.toLowerCase()}`;
}

/** 审计留痕: 内存环形 + PG audit_log 双写; PG 失败不阻塞业务 */
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

export function parseEnvText(text: string): Record<string, string> {
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

/** 解析 KEY=VALUE 文本 (注释/空行跳过) */
export function parseEnvTextSafe(text: string): Record<string, string> {
  return parseEnvText(text);
}
