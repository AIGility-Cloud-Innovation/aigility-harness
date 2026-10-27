/**
 * 用「用户身份」调飞书任务 API（与生产 review-aware.ts 同源：identity=user）。
 * 用户 token 从 config/feishu/user_token.local.json 读；过期则用 refresh_token 刷新并回写。
 */
import { readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = "/home/johnny/AI/aigility-harness/.env";
const TOKEN_PATH = "/home/johnny/AI/aigility-harness/config/feishu/user_token.local.json";

export function loadEnvFile(p = ENV_PATH): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) o[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return o;
}

export interface UserToken { access_token: string; refresh_token: string; expires_at: string; scope?: string }

function read(): UserToken { return JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as UserToken; }
function write(t: UserToken) { writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2)); }

/** 取有效用户 token（过期则刷新）。scope 不足时抛错提示重新授权。 */
export async function userToken(): Promise<string> {
  const env = loadEnvFile();
  const appId = env["FEISHU_APP_ID"]!;
  const appSecret = env["FEISHU_APP_SECRET"]!;
  let t = read();
  const exp = Date.parse(t.expires_at);
  if (Number.isFinite(exp) && exp - Date.now() > 5 * 60_000) return t.access_token;

  // 刷新：POST /open-apis/authen/v2/oauth/token (refresh_token grant)
  const r = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: appId,
      client_secret: appSecret,
      refresh_token: t.refresh_token,
    }),
  });
  const d = (await r.json()) as {
    code?: number; error?: string; error_description?: string;
    access_token?: string; refresh_token?: string; expires_in?: number;
    refresh_token_expires_in?: number;
  };
  if (!d.access_token) {
    throw new Error(
      `用户 token 刷新失败: ${d.code ?? ""} ${d.error ?? ""} ${d.error_description ?? ""}\n` +
      `→ 可能需要重新扫码授权（scope 不足）。见 feishu-oauth-qr 技能。`,
    );
  }
  const next: UserToken = {
    access_token: d.access_token,
    refresh_token: d.refresh_token ?? t.refresh_token,
    expires_at: new Date(Date.now() + (d.expires_in ?? 7200) * 1000).toISOString(),
    ...(t.scope ? { scope: t.scope } : {}),
  };
  write(next);
  console.log("  （用户 token 已刷新并回写）");
  return next.access_token;
}