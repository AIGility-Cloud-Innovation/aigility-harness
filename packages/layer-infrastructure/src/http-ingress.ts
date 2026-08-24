/**
 * L5 底座层: HTTP Server
 *
 * 监听 HTTP 端口，接收外部请求，转成内部格式交给 L2 角色形象。
 * 纯传输通道，不含任何业务逻辑。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface HttpIngressRequest {
  /** 监听端口 */
  port: number;
  /** 路由路径 */
  path: string;
  /** 交给哪个 L2 角色形象处理 (能力 ID) */
  perceptionId: string;
  /** 能力版本范围 */
  perceptionVersion?: string;
}

export interface HttpIngressResponse {
  started: boolean;
  port: number;
  path: string;
}

export const httpIngressService: ServiceDefinition<HttpIngressRequest, HttpIngressResponse> = {
  id: "@infrastructure/http-ingress",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "HTTP 入口服务，接收外部请求转交 L2",
};

// ── Provider 实现 ────────────────────────────────────────────────

let server: Server | null = null;
let activeCtx: SeamContext | null = null;

const httpIngressProvider: Provider<HttpIngressRequest, HttpIngressResponse> = {
  service: httpIngressService,
  name: "infrastructure-http-ingress",
  state: PluginState.Active,
  async execute(
    request: HttpIngressRequest,
    ctx: SeamContext,
  ): Promise<Result<HttpIngressResponse>> {
    activeCtx = ctx;

    if (server) {
      server.close();
    }

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === request.path) {
        try {
          const body = await readBody(req);
          const payload = JSON.parse(body);

          // 交给 L2 角色形象处理
          const result = await ctx.call(
            { id: request.perceptionId, versionRange: request.perceptionVersion ?? "^1.0.0" },
            payload,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    await new Promise<void>((resolve) => {
      server!.listen(request.port, () => resolve());
    });

    return ok({ started: true, port: request.port, path: request.path });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: server?.listening ?? false,
      detail: server?.listening ? "HTTP server listening" : "HTTP server not started",
      checkedAt: new Date().toISOString(),
    };
  },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 关闭 HTTP server */
export async function stopHttpServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
}

export { httpIngressProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@infrastructure/http-ingress",
  layer: LayerId.Infrastructure,
  description: "底座层：HTTP 入口服务",
  version: "0.1.0",
  provides: [httpIngressService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    await stopHttpServer();
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [httpIngressProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
