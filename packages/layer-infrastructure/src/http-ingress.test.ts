/**
 * http-ingress 路由判定单测
 *
 * routeRequest 是纯函数：根据 URL 路径判定走 dev（协议适配）还是
 * agent（角色形象）链路。覆盖默认路径、自定义路径、查询串、未知路径。
 *
 * 另含 SSE 流式分支集成测试：真实起 node:http server + mock SeamContext，
 * 验证 stream:true 请求返回 text/event-stream 帧流。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  routeRequest,
  HttpRouteKind,
  httpIngressProvider,
  stopHttpServer,
  httpIngressService,
} from "./http-ingress.js";
import { LayerId, ok } from "@aigility-harness/core";
import type { SeamContext, Result } from "@aigility-harness/core";

const DEFAULT_DEV = ["/v1/chat/completions", "/v1/messages", "/v1/responses"];
const DEFAULT_AGENT = ["/api/chat"];

describe("routeRequest", () => {
  it("dev 链路：OpenAI Chat Completions 路径", () => {
    expect(routeRequest("/v1/chat/completions", DEFAULT_DEV, DEFAULT_AGENT)).toBe("dev");
  });

  it("dev 链路：Anthropic Messages 路径", () => {
    expect(routeRequest("/v1/messages", DEFAULT_DEV, DEFAULT_AGENT)).toBe("dev");
  });

  it("dev 链路：OpenAI Responses 路径", () => {
    expect(routeRequest("/v1/responses", DEFAULT_DEV, DEFAULT_AGENT)).toBe("dev");
  });

  it("agent 链路：/api/chat 角色形象路径", () => {
    expect(routeRequest("/api/chat", DEFAULT_DEV, DEFAULT_AGENT)).toBe("agent");
  });

  it("未知路径返回 unknown", () => {
    expect(routeRequest("/api/unknown", DEFAULT_DEV, DEFAULT_AGENT)).toBe("unknown");
    expect(routeRequest("/", DEFAULT_DEV, DEFAULT_AGENT)).toBe("unknown");
  });

  it("带查询串的路径剥离 query 后仍正确路由", () => {
    expect(routeRequest("/v1/chat/completions?foo=bar", DEFAULT_DEV, DEFAULT_AGENT)).toBe("dev");
    expect(routeRequest("/api/chat?session=1", DEFAULT_DEV, DEFAULT_AGENT)).toBe("agent");
  });

  it("undefined URL 按未知处理（不会抛异常）", () => {
    expect(routeRequest(undefined, DEFAULT_DEV, DEFAULT_AGENT)).toBe("unknown");
  });

  it("自定义路径覆盖默认值", () => {
    const dev = ["/custom/v1/chat"];
    const agent = ["/custom/chat"];
    expect(routeRequest("/custom/v1/chat", dev, agent)).toBe("dev");
    expect(routeRequest("/custom/chat", dev, agent)).toBe("agent");
    // 默认路径在自定义配置下不再命中
    expect(routeRequest("/v1/chat/completions", dev, agent)).toBe("unknown");
    expect(routeRequest("/api/chat", dev, agent)).toBe("unknown");
  });
});

// ── SSE 流式分支集成测试 ─────────────────────────────────────────

/** mock SeamContext：固化 protocol-adapter 的返回（openai-chat 形态）。 */
function mockSseContext(): SeamContext {
  return {
    sessionId: "it-sse-session",
    traceId: "it-sse-trace",
    callerLayer: LayerId.Infrastructure,
    addEffect: () => "effect-1",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: (async (_ref: unknown, req: unknown) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      // 模拟 stub LLM 的 text 形态（openai-chat 协议适配后）
      return ok({
        protocol: "openai-chat",
        response: {
          text: `[stub-llm] echo: ${JSON.stringify(body["messages"] ?? []).slice(0, 60)}`,
          message: { role: "assistant", content: null },
          model: "qwen-turbo",
          finish_reason: "stop",
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        },
      }) as Result<unknown>;
    }) as SeamContext["call"],
  };
}

afterEach(async () => {
  await stopHttpServer();
});

describe("http-ingress SSE 流式分支", () => {
  it("stream:true 请求返回 text/event-stream 帧流直至 [DONE]", async () => {
    const bind = await httpIngressProvider.execute(
      { port: 18321 },
      mockSseContext(),
    );
    expect(bind.ok).toBe(true);

    const resp = await fetch("http://127.0.0.1:18321/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-turbo",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const raw = await resp.text();
    // 帧序列: role 帧 → 内容帧 → 收尾帧(usage) → [DONE]
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));

    expect(lines.length).toBe(4);
    expect(lines[lines.length - 1]).toBe("data: [DONE]");

    const first = JSON.parse(lines[0].slice("data: ".length).trim());
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.role).toBe("assistant");

    const second = JSON.parse(lines[1].slice("data: ".length).trim());
    expect(second.choices[0].delta.content).toContain("[stub-llm]");

    const third = JSON.parse(lines[2].slice("data: ".length).trim());
    expect(third.choices[0].finish_reason).toBe("stop");
    expect(third.usage.total_tokens).toBe(12);
  });

  it("非 stream 请求仍返回 JSON 一次性响应", async () => {
    const bind = await httpIngressProvider.execute(
      { port: 18322 },
      mockSseContext(),
    );
    expect(bind.ok).toBe(true);

    const resp = await fetch("http://127.0.0.1:18322/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-turbo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    const body = (await resp.json()) as { protocol?: string; response?: { text?: string } };
    expect(body.response?.text).toContain("[stub-llm]");
  });

  it("流式请求但下游调用失败 → SSE 错误帧 + [DONE]", async () => {
    const failingCtx: SeamContext = {
      sessionId: "it-sse-fail",
      traceId: "trace-fail",
      callerLayer: LayerId.Infrastructure,
      addEffect: () => "e",
      emit: () => {},
      getState: () => undefined,
      setState: () => {},
      call: (async () => ({ ok: false as const, error: "llm down" })) as SeamContext["call"],
    };
    const bind = await httpIngressProvider.execute(
      { port: 18323 },
      failingCtx,
    );
    expect(bind.ok).toBe(true);

    const resp = await fetch("http://127.0.0.1:18323/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
    });

    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const raw = await resp.text();
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
    expect(lines[0]).toContain("error");
    expect(lines[lines.length - 1]).toBe("data: [DONE]");
  });
});