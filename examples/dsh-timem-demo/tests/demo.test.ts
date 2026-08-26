import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { createServer, type Server } from "node:http";
import { timemPlugin, TimemService } from "@timem/dsh-plugin-timem";

// 扩展 cordis Context 类型 (与插件声明一致)
declare module "@deepseek-ai/cordis" {
  interface Context {
    timem: TimemService;
  }
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    // 简易 mock: 返回固定 JSON
    res.writeHead(200, { "Content-Type": "application/json" });
    const body = JSON.stringify({ ok: true, data: "mock-response" });
    res.end(body);
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("dsh-timem-demo: 插件插入 cordis Context", () => {
  it("timemPlugin 可被 ctx.plugin 加载 (插在 DeepSeek Harness 运行时上)", async () => {
    const root = new Context();
    await root.plugin(timemPlugin, { apiKey: "test-key", baseUrl });
    expect(root.timem).toBeInstanceOf(TimemService);
    await root.fiber.dispose();
  });

  it("ctx.timem.search 远程调用可用", async () => {
    const root = new Context();
    await root.plugin(timemPlugin, { apiKey: "test-key", baseUrl });
    const result = await root.timem.search({ user_id: "u1", query: "q" });
    expect(result).toHaveProperty("data", "mock-response");
    await root.fiber.dispose();
  });

  it("ctx.timem.recallRules 远程调用可用", async () => {
    const root = new Context();
    await root.plugin(timemPlugin, { apiKey: "test-key", baseUrl });
    const result = await root.timem.recallRules({ scene: "简历评估" });
    expect(Array.isArray(result)).toBe(true);
    await root.fiber.dispose();
  });
});