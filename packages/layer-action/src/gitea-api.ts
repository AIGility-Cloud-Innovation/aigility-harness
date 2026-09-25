/**
 * @aigility-harness/layer-action — Gitea Open API 直连能力
 *
 * @action/gitea-api — D3 行动层出站工具：透传调用 git.aigility.cloud（智悦云创 Gitea，
 * TiMEM-AI 组织）的 Gitea v1 API（工单/标签/里程碑/评论/仓库信息等）。
 *
 * 与 @action/feishu-api 同构：请求格式 method/path/query/body 对齐，path 必须以 /
 * 开头（含 /api/v1 前缀），响应以 HTTP status 判定成功（Gitea 无飞书式业务 code）。
 *
 * 实例经验已固化（来源 ~/.agents/skills/gitea-aigility/SKILL.md）：
 *   1. 本机系统 DNS 被污染，git.aigility.cloud 必须用公共 DNS 解析出的真实 IP 固定
 *      连接（等价 curl --resolve）。实现：node:dns Resolver 直查公共 DNS（默认
 *      223.5.5.5，结果缓存 5 分钟，失败回退已知 IP），https.request 用 lookup 回调
 *      固定 IP，URL 仍用域名 → TLS SNI / Host 头 / 证书校验全部自然正确。
 *   2. 认证：GITEA_TOKEN 环境变量优先，否则读 ~/.gitea-token（一行，strip）。
 *      请求头 Authorization: token <TOKEN>。注意 /api/v1/user 返回 403 属预期
 *      （token scope 不含 read:user），验证令牌用 GET /repos/{owner}/{repo}。
 *   3. 实例怪癖：PATCH 工单返回 201 而非 200（但生效，调用方应校验响应体 state）；
 *      项目看板(/projects)与依赖关系(blocked by)无 API，只能网页手动操作。
 */

import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { Resolver } from "node:dns";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 能力契约 ─────────────────────────────────────────────────────

/** 请求级覆盖（不传则读环境变量/默认值） */
export interface GiteaApiCredentials {
  token?: string;
  baseUrl?: string;
  /** 公共 DNS 服务器（绕开被污染的系统 DNS），默认 223.5.5.5 */
  dnsServer?: string;
  /** DNS 解析失败时回退的已知 IP，默认 43.143.234.148（2026-09-22 解析值） */
  fallbackIp?: string;
  /** 令牌文件路径覆盖，默认 ~/.gitea-token */
  tokenPath?: string;
}

export interface GiteaApiRequest {
  /** HTTP 方法，默认 GET */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** API 路径，含 /api/v1 前缀，如 /api/v1/repos/TiMEM-AI/x/issues（必须以 / 开头） */
  path: string;
  /** URL 查询参数（值会被 encodeURIComponent） */
  query?: Record<string, string | number | boolean>;
  /** JSON 请求体（对象，自动序列化为 UTF-8 JSON） */
  body?: unknown;
  /** 覆盖 API 基址，默认 https://git.aigility.cloud */
  baseUrl?: string;
  /** 请求超时毫秒，默认 20000 */
  timeoutMs?: number;
  /** 请求级覆盖 */
  credentials?: GiteaApiCredentials;
}

export interface GiteaApiResponse {
  /** HTTP 状态码（2xx=成功；注意本实例 PATCH 工单返回 201） */
  status: number;
  /** 响应体（JSON 解析结果；非 JSON 时为原始文本） */
  data: unknown;
}

export const giteaApiService: ServiceDefinition<GiteaApiRequest, GiteaApiResponse> = {
  id: "@action/gitea-api",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "Gitea v1 API 直连（git.aigility.cloud 透传任意接口；公共 DNS 绕行污染 + token 认证）",
};

// ── 纯函数（导出供测试） ─────────────────────────────────────────

const DEFAULT_BASE = "https://git.aigility.cloud";
const DEFAULT_DNS = "223.5.5.5";
/** 2026-09-22 经 223.5.5.5 解析的真实 IP；IP 可能变更，仅作 DNS 失败时的兜底 */
const DEFAULT_FALLBACK_IP = "43.143.234.148";

export function readGiteaEnv(
  overrides?: GiteaApiCredentials,
): Required<Omit<GiteaApiCredentials, "token">> & { token?: string } {
  return {
    token: overrides?.token ?? process.env.GITEA_TOKEN ?? undefined,
    baseUrl: overrides?.baseUrl ?? process.env.GITEA_BASE_URL ?? DEFAULT_BASE,
    dnsServer: overrides?.dnsServer ?? process.env.GITEA_DNS_SERVER ?? DEFAULT_DNS,
    fallbackIp:
      overrides?.fallbackIp ?? process.env.GITEA_FALLBACK_IP ?? DEFAULT_FALLBACK_IP,
    tokenPath:
      overrides?.tokenPath ?? process.env.GITEA_TOKEN_PATH ?? join(homedir(), ".gitea-token"),
  };
}

/** IPv4 格式校验（DNS 结果与兜底 IP 都要过这一关） */
export function isValidIPv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((p) => Number(p) <= 255);
}

/** 拼接完整 URL（query 值做 URI 编码） */
export function buildGiteaUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  if (!path.startsWith("/")) {
    throw new Error(`gitea-api: path 必须以 / 开头（含 /api/v1 前缀），收到 "${path}"`);
  }
  let url = `${baseUrl.replace(/\/$/, "")}${path}`;
  if (query && Object.keys(query).length > 0) {
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    url += `?${qs}`;
  }
  return url;
}

// ── DNS 绕行与令牌 ───────────────────────────────────────────────

const ipCache = new Map<string, { ip: string; expiresAt: number }>();
const IP_CACHE_TTL_MS = 5 * 60_000;

/** 用公共 DNS 解析域名真实 IP（绕开被污染的系统 DNS），失败回退已知 IP；结果缓存 5 分钟 */
export async function resolveHostIp(
  host: string,
  dnsServer: string,
  fallbackIp: string,
): Promise<string> {
  const cached = ipCache.get(host);
  if (cached && Date.now() < cached.expiresAt) return cached.ip;

  const ip = await new Promise<string>((resolve) => {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([dnsServer]);
    resolver.resolve4(host, (e, addrs) => {
      const last = addrs?.[addrs.length - 1] ?? "";
      if (!e && isValidIPv4(last)) resolve(last);
      else resolve(fallbackIp);
    });
  });
  ipCache.set(host, { ip, expiresAt: Date.now() + IP_CACHE_TTL_MS });
  return ip;
}

/** 令牌：请求级覆盖 → GITEA_TOKEN 环境变量 → ~/.gitea-token 文件（strip，容错 BOM） */
export async function loadGiteaToken(env: ReturnType<typeof readGiteaEnv>): Promise<string> {
  if (env.token) return env.token.trim();
  const raw = await readFile(env.tokenPath, "utf8");
  const token = raw.replace(/^\uFEFF/, "").trim();
  if (!token) {
    throw new Error(`gitea-api: 令牌为空（${env.tokenPath}），请配置 GITEA_TOKEN 或写入令牌文件`);
  }
  return token;
}

/** HTTPS JSON 请求：lookup 回调固定 IP（URL 保持域名 → SNI/证书校验不受影响） */
function httpsJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number; ip: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method,
        headers: init.headers,
        // Node ≥20 以 all:true 调 lookup 并要求数组结果（autoSelectFamily），旧签名兼容
        lookup: (_host, opts, cb) =>
          opts?.all
            ? cb(null, [{ address: init.ip, family: 4 }])
            : cb(null, init.ip, 4),
        signal: AbortSignal.timeout(init.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ── Provider 实现 ────────────────────────────────────────────────

export const giteaApiProvider: Provider<GiteaApiRequest, GiteaApiResponse> = {
  service: giteaApiService,
  name: "action-gitea-api",
  state: PluginState.Active,

  async execute(
    request: GiteaApiRequest,
    ctx: SeamContext,
  ): Promise<Result<GiteaApiResponse>> {
    const env = readGiteaEnv(request.credentials);
    const method = request.method ?? "GET";
    const timeoutMs = request.timeoutMs ?? 20_000;

    let url: string;
    try {
      url = buildGiteaUrl(env.baseUrl, request.path, request.query);
    } catch (e) {
      return err((e as Error).message);
    }

    try {
      const token = await loadGiteaToken(env);
      const ip = await resolveHostIp(new URL(url).hostname, env.dnsServer, env.fallbackIp);

      const headers: Record<string, string> = {
        authorization: `token ${token}`,
        accept: "application/json",
      };
      let body: string | undefined;
      if (request.body !== undefined) {
        headers["content-type"] = "application/json; charset=utf-8";
        body = JSON.stringify(request.body);
      }

      ctx.emit({
        type: "gitea.api.call",
        layer: LayerId.Action,
        payload: { method, path: request.path },
        traceId: ctx.traceId,
      });

      const r = await httpsJson(url, { method, headers, body, timeoutMs, ip });
      let data: unknown = r.text;
      try {
        data = JSON.parse(r.text);
      } catch {
        // 非 JSON（如空体）保留原文
      }
      return ok({ status: r.status, data });
    } catch (e) {
      return err(`gitea-api: ${method} ${request.path} 失败: ${(e as Error).message}`);
    }
  },

  async health(): Promise<HealthStatus> {
    const env = readGiteaEnv();
    if (!env.token) {
      try {
        await loadGiteaToken(env);
      } catch (e) {
        return {
          healthy: false,
          detail: `Gitea 令牌未配置（GITEA_TOKEN 或 ${env.tokenPath}）：${(e as Error).message}`,
          checkedAt: new Date().toISOString(),
        };
      }
    }
    return {
      healthy: true,
      detail: `令牌已配置（DNS 绕行: ${env.dnsServer}，回退 IP ${env.fallbackIp}）`,
      checkedAt: new Date().toISOString(),
    };
  },
};
