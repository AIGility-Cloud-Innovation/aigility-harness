/**
 * L5 Infrastructure 插件 — HTTP Gateway (Hono + Vercel AI SDK)
 *
 * 框架只声明 Seam 契约；Hono 和 Vercel AI SDK 的 API 直接用。
 * 暴露 OpenAI 兼容 /v1/chat/completions，ReAct 循环由 Vercel AI SDK 内置。
 */

import { LayerId, CarrierKind, PluginState, ok } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, stepCountIs } from "ai";

// ── Seam 服务定义 ──────────────────────────────────────────────

export const httpGatewayService: ServiceDefinition = {
  id: "@infrastructure/http-gateway",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "HTTP 网关（Hono），OpenAI 兼容接口 + ReAct 循环 + SSE 流式",
};

// ── 配置 ────────────────────────────────────────────────────────

export interface GatewayConfig {
  port: number;
  litellmUrl: string;
  litellmKey: string;
  maxSteps: number;
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3000,
  litellmUrl: process.env.LITELLM_URL || "http://127.0.0.1:48724",
  litellmKey: process.env.LITELLM_KEY || "sk-1234",
  maxSteps: 10,
};

// ── Provider（Seam 声明）──────────────────────────────────────

const httpGatewayProvider: Provider = {
  service: httpGatewayService,
  name: "infrastructure-http-gateway-hono",
  state: PluginState.Active,
  async execute(_request: unknown, _ctx: SeamContext): Promise<Result<unknown>> {
    return ok({ status: "running" });
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, checkedAt: new Date().toISOString() };
  },
};

// ── Hono App ───────────────────────────────────────────────────

export function createGatewayApp(cfg: Partial<GatewayConfig> = {}): Hono {
  const config = { ...DEFAULT_CONFIG, ...cfg };
  const app = new Hono();

  const openai = createOpenAI({
    baseURL: `${config.litellmUrl}/v1`,
    apiKey: config.litellmKey,
  });

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json();
    const { model, messages, stream, tools } = body;
    const llm = openai(model);

    // 工具定义 → Vercel AI SDK tool 格式
    const aiTools = tools ? Object.fromEntries(
      tools.map((t: { function: { name: string; description?: string; parameters?: unknown } }) => [
        t.function.name,
        {
          description: t.function.description,
          parameters: t.function.parameters,
          execute: async (args: unknown) => args, // 透传到 L4 action 层
        },
      ]),
    ) : undefined;

    if (stream) {
      return streamSSE(c, async (stream) => {
        const result = streamText({
          model: llm,
          messages,
          tools: aiTools,
          stopWhen: stepCountIs(config.maxSteps),
        });

        for await (const delta of result.textStream) {
          await stream.writeSSE({
            data: JSON.stringify({
              choices: [{ delta: { content: delta }, finish_reason: null }],
            }),
          });
        }
        await stream.writeSSE({ data: "[DONE]" });
      });
    }

    // 非流式
    const result = streamText({
      model: llm,
      messages,
      tools: aiTools,
      stopWhen: stepCountIs(config.maxSteps),
    });

    const text = await result.text;
    const usage = await result.usage;
    return c.json({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}

// ── 启动入口 ───────────────────────────────────────────────────

export async function startGateway(cfg: Partial<GatewayConfig> = {}) {
  const config = { ...DEFAULT_CONFIG, ...cfg };
  const app = createGatewayApp(config);
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port: config.port });
  console.log(`🚀 Gateway on http://localhost:${config.port}`);
  return app;
}

// ── Layer Plugin 声明 ──────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@aigility-harness/gateway",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "HTTP Gateway 插件（Hono + Vercel AI SDK）",
  provides: [httpGatewayService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

export const plugin: LayerPlugin = {
  manifest,
  getProviders(): Provider[] {
    return [httpGatewayProvider];
  },
  async onLoad(ctx: SeamContext): Promise<Result<void>> {
    ctx.emit({
      type: "gateway.loaded",
      layer: LayerId.Infrastructure,
      payload: {},
      traceId: ctx.traceId,
    });
    return ok(undefined);
  },
  getState() {
    return PluginState.Active;
  },
};
