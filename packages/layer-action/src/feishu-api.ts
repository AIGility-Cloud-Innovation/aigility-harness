/**
 * @aigility-harness/layer-action — 飞书 Open API 直连能力（用户身份/应用身份）
 *
 * @action/feishu-api — D3 行动层出站工具：以「用户身份(user_access_token)」或
 * 「应用身份(tenant_access_token)」透传调用飞书 Open API 任意接口。
 *
 * 与 D1 @infrastructure/feishu（feishu-ingress，入站收消息）互补成闭环：
 *   ingress 收 "@机器人 建个任务 xx" → persona → orchestration → 本插件建任务
 *   → ingress 的 im.message.reply 回群。
 *
 * 凭证来源（与 feishu-ingress 共用同一组环境变量，零额外配置）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   — 必填，应用凭证（两种身份都依赖）
 *   FEISHU_USER_TOKEN_STORE             — 可选，user token 落盘路径，
 *                                         默认 <cwd>/feishu/user_token.local.json
 *                                         （本地凭证仓，整个 feishu/ 已 gitignore）
 *
 * 用户身份首次授权由本插件内置完成：buildAuthorizeUrl 生成授权链接 +
 * exchangeAuthCode 换 token 落盘；配套交互脚本 packages/layer-action/
 * authorize-feishu.ts（自动本地回调 / 手动两模式，替代已退役的
 * feishu/oauth-*.ps1 与 feishu.mjs）。token 过期自动用 refresh_token
 * 续期并回写落盘；续期失败返回 ok:false 并提示重新授权。
 *
 * 备注：本机 Schannel（Windows 系统 TLS）损坏时 Node 内置 fetch/OpenSSL 不受影响，
 * 本插件全部走 node:fetch。
 */

import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ── 能力契约 ─────────────────────────────────────────────────────

/** 请求级凭证覆盖（不传则读环境变量）。用于网关应用与 API 应用不是同一 app 的装配。 */
export interface FeishuApiCredentials {
  appId?: string;
  appSecret?: string;
  /** user token 落盘路径覆盖 */
  tokenStorePath?: string;
}

export interface FeishuApiRequest {
  /** HTTP 方法，默认 GET */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** API 路径，如 /open-apis/task/v2/tasks（必须以 / 开头） */
  path: string;
  /** URL 查询参数（值会被 encodeURIComponent） */
  query?: Record<string, string | number | boolean>;
  /** JSON 请求体（对象，自动序列化为 UTF-8 JSON） */
  body?: unknown;
  /** 调用身份：user=用户身份(默认，任务 v2 等要求)，tenant=应用身份 */
  identity?: "user" | "tenant";
  /** 覆盖 API 基址，默认 https://open.feishu.cn */
  baseUrl?: string;
  /** 请求超时毫秒，默认 20000 */
  timeoutMs?: number;
  /** 请求级凭证覆盖（与 ingress 不同 app 的装配场景） */
  credentials?: FeishuApiCredentials;
}

export interface FeishuApiResponse {
  /** 飞书业务返回码，0=成功 */
  code: number;
  msg: string;
  /** 业务数据（data 字段原文） */
  data: unknown;
}

export const feishuApiService: ServiceDefinition<FeishuApiRequest, FeishuApiResponse> = {
  id: "@action/feishu-api",
  version: "1.1.0",
  layer: LayerId.Action,
  description:
    "飞书 Open API 直连（用户身份/应用身份透传任意接口，token 自动续期 + 用户 OAuth 授权引导；与 feishu-ingress 共用凭证）",
};

// ── 纯函数（导出供测试） ─────────────────────────────────────────

const DEFAULT_BASE = "https://open.feishu.cn";
const AUTHORIZE_BASE = "https://accounts.feishu.cn";

/** OAuth 回调地址约定：须与飞书开放平台应用注册的重定向 URL 一致 */
export const DEFAULT_REDIRECT_URI = "http://localhost:18080/callback";
/** 默认授权范围：空格分隔（飞书约定，逗号分隔会报 20043） */
export const DEFAULT_SCOPES = "task:task:read task:task:write";

/** 拼接完整 URL（query 值做 URI 编码） */
export function buildFeishuUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  if (!path.startsWith("/")) {
    throw new Error(`feishu-api: path 必须以 / 开头，收到 "${path}"`);
  }
  let url = `${baseUrl.replace(/\/$/, "")}${path}`;
  if (query && Object.keys(query).length > 0) {
    const qs = Object.entries(query)
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&");
    url += `?${qs}`;
  }
  return url;
}

/** ISO 时间串是否已过期（提前 60s 视为过期，避免边界竞争） */
export function isTokenExpired(expiresAtIso: string, now = Date.now()): boolean {
  const t = Date.parse(expiresAtIso);
  if (Number.isNaN(t)) return true;
  return now >= t - 60_000;
}

/** 从 OAuth 回调完整 URL 中提取 code；裸 code 原样返回；无则 null */
export function extractAuthCode(callbackUrlOrCode: string): string | null {
  const m = callbackUrlOrCode.match(/[?&]code=([^&\s]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9._-]+$/.test(callbackUrlOrCode) ? callbackUrlOrCode : null;
}

export interface AuthorizeUrlOptions {
  appId: string;
  /** 回调地址，默认 DEFAULT_REDIRECT_URI */
  redirectUri?: string;
  /** 授权范围（空格分隔串或数组），默认 DEFAULT_SCOPES */
  scopes?: string | string[];
  /** 防 CSRF 串，缺省自动生成 32 位 hex */
  state?: string;
}

export interface AuthorizeUrl {
  url: string;
  redirectUri: string;
  state: string;
  scopes: string;
}

/** 生成用户身份 OAuth 授权链接（浏览器打开 → 同意 → 跳到 redirectUri 带 code） */
export function buildAuthorizeUrl(opts: AuthorizeUrlOptions): AuthorizeUrl {
  const redirectUri = opts.redirectUri ?? DEFAULT_REDIRECT_URI;
  const scopes =
    (Array.isArray(opts.scopes) ? opts.scopes.join(" ") : opts.scopes) ?? DEFAULT_SCOPES;
  const state = opts.state ?? randomUUID().replaceAll("-", "");
  const url = buildFeishuUrl(AUTHORIZE_BASE, "/open-apis/authen/v1/authorize", {
    app_id: opts.appId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });
  return { url, redirectUri, state, scopes };
}

// ── Token 管理 ───────────────────────────────────────────────────

interface UserTokenRecord {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  scope?: string;
}

export interface TokenEnv {
  appId: string;
  appSecret: string;
  tokenStorePath: string;
}

export function readTokenEnv(overrides?: FeishuApiCredentials): TokenEnv {
  return {
    appId: overrides?.appId ?? process.env.FEISHU_APP_ID ?? "",
    appSecret: overrides?.appSecret ?? process.env.FEISHU_APP_SECRET ?? "",
    tokenStorePath:
      overrides?.tokenStorePath ??
      process.env.FEISHU_USER_TOKEN_STORE ??
      "feishu/user_token.local.json",
  };
}

let cachedTenantToken: { token: string; expiresAt: number } | null = null;

/** 应用身份 tenant_access_token（内存缓存，提前 60s 刷新） */
async function getTenantToken(env: TokenEnv, baseUrl: string): Promise<string> {
  if (cachedTenantToken && Date.now() < cachedTenantToken.expiresAt) {
    return cachedTenantToken.token;
  }
  const r = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.appId, app_secret: env.appSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json()) as { code: number; msg: string; expire?: number; tenant_access_token?: string };
  if (j.code !== 0 || !j.tenant_access_token) {
    throw new Error(`feishu-api: 获取 tenant_access_token 失败: ${j.msg} (code=${j.code})`);
  }
  cachedTenantToken = {
    token: j.tenant_access_token,
    expiresAt: Date.now() + ((j.expire ?? 7200) - 60) * 1000,
  };
  return cachedTenantToken.token;
}

async function loadUserRecord(env: TokenEnv): Promise<UserTokenRecord> {
  const raw = await readFile(env.tokenStorePath, "utf8");
  return JSON.parse(raw) as UserTokenRecord;
}

async function persistUserRecord(env: TokenEnv, rec: UserTokenRecord): Promise<void> {
  await mkdir(dirname(env.tokenStorePath), { recursive: true });
  await writeFile(env.tokenStorePath, JSON.stringify(rec, null, 2), "utf8");
}

/** 授权码换用户 token 并落盘（首次 OAuth 授权的最后一步） */
export async function exchangeAuthCode(
  env: TokenEnv,
  code: string,
  opts?: { baseUrl?: string; redirectUri?: string },
): Promise<UserTokenRecord> {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE;
  const r = await fetch(`${baseUrl}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.appId,
      client_secret: env.appSecret,
      code,
      redirect_uri: opts?.redirectUri ?? DEFAULT_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!j.access_token || !j.refresh_token) {
    throw new Error(`feishu-api: 授权码换 token 失败: ${JSON.stringify(j)}`);
  }
  const rec: UserTokenRecord = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: new Date(Date.now() + ((j.expires_in ?? 7200) - 60) * 1000).toISOString(),
    scope: j.scope,
  };
  await persistUserRecord(env, rec);
  return rec;
}

/** 用户身份 token：读取落盘记录，过期自动 refresh 并回写 */
export async function getFreshUserToken(env: TokenEnv, baseUrl: string): Promise<string> {
  const rec = await loadUserRecord(env);
  if (!isTokenExpired(rec.expires_at)) return rec.access_token;

  const r = await fetch(`${baseUrl}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.appId,
      client_secret: env.appSecret,
      refresh_token: rec.refresh_token,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!j.access_token || !j.refresh_token) {
    throw new Error(
      "feishu-api: 用户 token 续期失败（refresh_token 可能已失效），请重新走一次 OAuth 授权（npx tsx packages/layer-action/authorize-feishu.ts）",
    );
  }
  const next: UserTokenRecord = {
    access_token: j.access_token,
    // 注意：飞书 refresh 响应不返回新 refresh_token，必须保留旧值，否则下次续期必失败
    refresh_token: j.refresh_token ?? rec.refresh_token,
    expires_at: new Date(Date.now() + ((j.expires_in ?? 7200) - 60) * 1000).toISOString(),
    scope: j.scope ?? rec.scope,
  };
  await persistUserRecord(env, next);
  return next.access_token;
}

// ── Provider 实现 ────────────────────────────────────────────────

export const feishuApiProvider: Provider<FeishuApiRequest, FeishuApiResponse> = {
  service: feishuApiService,
  name: "action-feishu-api",
  state: PluginState.Active,

  async execute(
    request: FeishuApiRequest,
    ctx: SeamContext,
  ): Promise<Result<FeishuApiResponse>> {
    const env = readTokenEnv(request.credentials);
    if (!env.appId || !env.appSecret) {
      return err("feishu-api: 缺少凭证（FEISHU_APP_ID/SECRET 或 request.credentials）");
    }
    const method = request.method ?? "GET";
    const identity = request.identity ?? "user";
    const baseUrl = request.baseUrl ?? DEFAULT_BASE;

    let url: string;
    try {
      url = buildFeishuUrl(baseUrl, request.path, request.query);
    } catch (e) {
      return err((e as Error).message);
    }

    try {
      const token =
        identity === "tenant"
          ? await getTenantToken(env, baseUrl)
          : await getFreshUserToken(env, baseUrl);

      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      const init: RequestInit = { method, headers };
      if (request.body !== undefined) {
        headers["content-type"] = "application/json; charset=utf-8";
        init.body = JSON.stringify(request.body);
      }
      if (request.timeoutMs ?? 0 > 0) init.signal = AbortSignal.timeout(request.timeoutMs!);

      ctx.emit({
        type: "feishu.api.call",
        layer: LayerId.Action,
        payload: { method, path: request.path, identity },
        traceId: ctx.traceId,
      });

      const resp = await fetch(url, init);
      const j = (await resp.json()) as { code?: number; msg?: string; data?: unknown };
      // auth/v3 系接口业务码在顶层；open-apis 系也在顶层 code
      const code = j.code ?? (resp.ok ? 0 : resp.status);
      return ok({ code, msg: j.msg ?? "", data: j.data ?? null });
    } catch (e) {
      return err(`feishu-api: ${method} ${request.path} 失败: ${(e as Error).message}`);
    }
  },

  async health(): Promise<HealthStatus> {
    const env = readTokenEnv();
    if (!env.appId || !env.appSecret) {
      return {
        healthy: false,
        detail: "FEISHU_APP_ID / FEISHU_APP_SECRET 未配置",
        checkedAt: new Date().toISOString(),
      };
    }
    let userTokenReady = false;
    try {
      const rec = await loadUserRecord(env);
      userTokenReady = Boolean(rec.refresh_token);
    } catch {
      // token store 不存在：用户身份不可用，但应用身份仍可用
    }
    return {
      healthy: true,
      detail: userTokenReady
        ? "凭证已配置（用户身份 + 应用身份可用）"
        : "凭证已配置（仅应用身份；用户身份需先完成 OAuth 授权）",
      checkedAt: new Date().toISOString(),
    };
  },
};
