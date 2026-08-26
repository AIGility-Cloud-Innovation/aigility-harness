/**
 * L5 底座层: HTTP Server — 唯一入口 + 显式路由
 *
 * 接收外部 HTTP 请求，按路径/内容特征路由到两条链路：
 *
 *   A. 开发者协议链路：/v1/chat/completions 等 → @infrastructure/protocol-adapter
 *      (翻译 Anthropic/OpenAI/Responses → 内部标准 → 认知层 LLM → 翻译回原协议)
 *
 *   B. 角色形象链路：/api/chat 等 → @persona/chat-agent
 *      (用户与人格化 Agent 对话 → 角色形象 → 编排层 workflow-engine)
 *
 * 纯传输通道 + 路由，不含业务逻辑。协议翻译交给 protocol-adapter，
 * 人格化交给 chat-agent，本插件只决定"谁来处理"。
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
  CapabilityRef,
} from "@aigility-harness/core";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface HttpIngressRequest {
  /** 监听端口 */
  port: number;
  /** 开发者协议链路: 哪些路径走 protocol-adapter (默认 /v1/chat/completions, /v1/messages) */
  devPaths?: string[];
  /** 角色形象链路: 哪些路径走 chat-agent (默认 /api/chat) */
  agentPaths?: string[];
  /** 交给哪个 L2 角色形象处理 (能力 ID), 默认 @persona/chat-agent */
  perceptionId?: string;
  /** 能力版本范围 */
  perceptionVersion?: string;
}

export interface HttpIngressResponse {
  started: boolean;
  port: number;
  /** 实际生效的路由表 */
  routes: {
    dev: string[];
    agent: string[];
  };
}

export const httpIngressService: ServiceDefinition<HttpIngressRequest, HttpIngressResponse> = {
  id: "@infrastructure/http-ingress",
  version: "1.1.0",
  layer: LayerId.Infrastructure,
  description: "HTTP 入口服务，按路径路由到协议适配或角色形象",
};

// ── 内部引用的能力 ───────────────────────────────────────────────

/** 消费协议适配能力（开发者链路） */
export const protocolAdapterRef: CapabilityRef = {
  id: "@infrastructure/protocol-adapter",
  versionRange: "^1.0.0",
};

/** 消费角色形象能力（用户链路） */
export const chatAgentRef: CapabilityRef = {
  id: "@persona/chat-agent",
  versionRange: "^1.0.0",
};

// ── 协议判定 ─────────────────────────────────────────────────────

export type HttpRouteKind = "dev" | "agent" | "unknown";

/**
 * 根据 URL 路径判定走哪条链路。
 * dev 路径: /v1/chat/completions (OpenAI), /v1/messages (Anthropic), /v1/responses (OpenAI Responses)
 * agent 路径: /api/chat 及自定义路径
 */
export function routeRequest(
  url: string | undefined,
  devPaths: string[],
  agentPaths: string[],
): HttpRouteKind {
  const path = (url ?? "").split("?")[0];
  if (devPaths.includes(path)) return "dev";
  if (agentPaths.includes(path)) return "agent";
  return "unknown";
}

const DEFAULT_DEV_PATHS = [
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
];
const DEFAULT_AGENT_PATHS = ["/api/chat"];

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

    const devPaths = request.devPaths ?? DEFAULT_DEV_PATHS;
    const agentPaths = request.agentPaths ?? DEFAULT_AGENT_PATHS;
    const perceptionId = request.perceptionId ?? "@persona/chat-agent";
    const perceptionVersion = request.perceptionVersion ?? "^1.0.0";

    if (server) {
      server.close();
    }

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const route = routeRequest(req.url, devPaths, agentPaths);

      if (route === "unknown") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Not found",
          hint: `Available routes: dev=${devPaths.join(",")} agent=${agentPaths.join(",")}`,
        }));
        return;
      }

      try {
        const body = await readBody(req);
        const payload = JSON.parse(body);

        if (route === "dev") {
          // 开发者链路：协议适配（OpenAI 兼容 / Anthropic / Responses）
          const protocol = req.url?.split("?")[0]?.includes("/v1/messages")
            ? "anthropic-messages"
            : req.url?.split("?")[0]?.includes("/v1/responses")
              ? "openai-responses"
              : "openai-chat";

          const result = await ctx.call(
            protocolAdapterRef,
            {
              protocol,
              body: payload,
              headers: Object.fromEntries(
                Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
              ),
            },
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.ok ? result.value : { error: result.error }));
          return;
        }

        // agent 链路：角色形象（用户人格化对话）
        const result = await ctx.call(
          { id: perceptionId, versionRange: perceptionVersion },
          payload,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.ok ? result.value : { error: result.error }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });

    await new Promise<void>((resolve) => {
      server!.listen(request.port, () => resolve());
    });

    return ok({
      started: true,
      port: request.port,
      routes: { dev: devPaths, agent: agentPaths },
    });
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
  description: "底座层：HTTP 唯一入口（路由到协议适配 / 角色形象）",
  version: "1.1.0",
  provides: [httpIngressService],
  consumes: [protocolAdapterRef, chatAgentRef],
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