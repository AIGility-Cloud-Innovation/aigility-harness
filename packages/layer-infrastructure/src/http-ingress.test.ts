/**
 * http-ingress 路由判定单测
 *
 * routeRequest 是纯函数：根据 URL 路径判定走 dev（协议适配）还是
 * agent（角色形象）链路。覆盖默认路径、自定义路径、查询串、未知路径。
 */
import { describe, it, expect } from "vitest";
import { routeRequest, HttpRouteKind } from "./http-ingress.js";

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