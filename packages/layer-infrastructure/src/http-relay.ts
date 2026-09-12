/**
 * L1 基础设施层: http-relay — 服务端 HTTP 转发能力 (具名目标, 防开放代理)
 *
 * 场景: 沙箱里的应用页面需要读取无 CORS 头的第三方/内网 HTTP 数据源
 * (如日志服务)。浏览器受同源策略限制读不到, 服务端(Node)没有此限制 ——
 * 页面 → 本层能力 → 目标源, 同源返回给页面。
 *
 * 安全边界: 不是开放代理。目标地址不来自请求参数, 而来自装配配置
 * APPBASE_RELAY_TARGETS (格式: name=url;name2=url2), 页面只传业务参数;
 * 未在清单中的 name 一律拒绝 (防 SSRF / 内网扫描)。
 *
 * 契约:
 *   Request  { name: string; query?: string; method?: "GET"; timeoutMs?: number }
 *   Response { ok: boolean; status: number; contentType: string; body: string; error?: string }
 */
import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
  err,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface HttpRelayRequest {
  /** 具名目标 (在 APPBASE_RELAY_TARGETS 或应用 .env 的 RELAY_<NAME> 中登记) */
  name: string;
  /** 显式目标地址 (由服务端解析后传入, 优先于具名查找; 须 http/https) */
  baseUrl?: string;
  /** 附加查询串 (不含 "?", 原样拼到目标 URL 后) */
  query?: string;
  /** 超时 (默认 20s) */
  timeoutMs?: number;
  /** 响应体上限 (默认 2MB, 防拉爆内存) */
  maxBytes?: number;
}

export interface HttpRelayResponse {
  ok: boolean;
  /** 上游 HTTP 状态码 */
  status: number;
  contentType: string;
  /** 上游响应体 (文本, 截断到 maxBytes) */
  body: string;
  error?: string;
}

export const httpRelayService: ServiceDefinition<HttpRelayRequest, HttpRelayResponse> = {
  id: "@infrastructure/http-relay",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "服务端 HTTP 转发 (具名目标): 读无 CORS 头的数据源, 防开放代理",
};

// ── 具名目标解析 ─────────────────────────────────────────────────

/** APPBASE_RELAY_TARGETS 格式: name=url;name2=url2 (url 含路径, 不含查询串) */
export function relayTargets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env.APPBASE_RELAY_TARGETS ?? "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const url = pair.slice(idx + 1).trim();
    if (name && /^https?:\/\//.test(url)) out[name] = url;
  }
  return out;
}

// ── Provider 实现 ────────────────────────────────────────────────

const httpRelayProvider: Provider<HttpRelayRequest, HttpRelayResponse> = {
  service: httpRelayService,
  name: "infrastructure-http-relay",
  state: PluginState.Active,
  async execute(
    request: HttpRelayRequest,
    _ctx: SeamContext,
  ): Promise<Result<HttpRelayResponse>> {
    const name = String(request.name ?? "").trim();
    let base = "";
    if (request.baseUrl && /^https?:\/\//.test(request.baseUrl)) {
      base = request.baseUrl;
    } else {
      base = relayTargets()[name] ?? "";
    }
    if (!base) {
      return err(
        `relay: 未知目标「${name}」。可在应用 .env 配置 RELAY_${name.toUpperCase()}=地址, 或全局 APPBASE_RELAY_TARGETS`,
      );
    }
    const url = base + (request.query ? (base.includes("?") ? "&" : "?") + request.query : "");
    const maxBytes = request.maxBytes ?? 2 * 1024 * 1024;
    try {
      const upstream = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(request.timeoutMs ?? 20_000),
      });
      const buf = await upstream.arrayBuffer();
      const body = new TextDecoder("utf-8", { fatal: false }).decode(
        buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf,
      );
      return ok({
        ok: upstream.ok,
        status: upstream.status,
        contentType: upstream.headers.get("content-type") ?? "text/plain",
        body,
        ...(upstream.ok ? {} : { error: `上游 HTTP ${upstream.status}` }),
      });
    } catch (e) {
      return ok({
        ok: false,
        status: 0,
        contentType: "",
        body: "",
        error: `relay fetch failed: ${String((e as Error)?.message ?? e)}`,
      });
    }
  },
  async health(): Promise<HealthStatus> {
    const n = Object.keys(relayTargets()).length;
    return {
      healthy: true,
      detail: `http-relay ready (${n} 个具名目标)`,
      checkedAt: new Date().toISOString(),
    };
  },
};

export { httpRelayProvider };

export const relayManifest: PluginManifest = {
  name: "@infrastructure/http-relay",
  layer: LayerId.Infrastructure,
  description: "基础设施：服务端 HTTP 转发能力（具名目标, 防开放代理）",
  version: "1.0.0",
  provides: [httpRelayService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
