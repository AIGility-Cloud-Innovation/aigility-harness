/**
 * AppBase 产品装配：多功能对话厅 + Codex 网页应用生成器 + 后端 API + AI 网关
 *
 * AppBase 产品形态:
 *   1. 多功能对话厅 (@infrastructure/hall) —— 框架自带基本前端, 多角色对话入口
 *      角色: codex-chat(Codex 网页应用生成器) / sales-chat / plugin-helper / coder
 *   2. 后端 API —— auth + apps 表 + 应用数据 (PG JSONB, 多租户隔离)
 *   3. AI 网关 (@infrastructure/http-ingress + protocol-adapter + llm-inference)
 *
 * 运行: cd examples/appbase && pnpm start
 * 访问: http://127.0.0.1:3419/hall  (对话厅)
 *       http://127.0.0.1:3419/app/apps  (后端 API)
 *       http://127.0.0.1:3418/v1/chat/completions  (AI 网关)
 */

import {
  LayerId,
  RunMode,
  bootstrap,
  shutdown,
  InProcessScheduler,
  ok,
} from "@aigility-harness/core";
import type { KernelConfig } from "@aigility-harness/core";
import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { createServer } from "node:http";
import { plugin as infrastructurePlugin } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";
import { appBackendHandler, initAppBackend } from "./backend.js";

const APP_PORT = 3419;
const GATEWAY_PORT = 3418;

async function main(): Promise<void> {
  console.log("=== AppBase（对话厅 + 网页应用生成器 + 后端 API + AI 网关）===\n");

  // 0. 初始化后端 (PG schema)
  await initAppBackend();

  // 1. 内核（原型模式，内存实现）
  const kernel = new InMemoryKernelAdapter();

  // 2. 装配四层插件
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
  ];
  console.log("装配插件:");
  for (const p of plugins) {
    console.log(`  - ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  // 3. bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "default",
    autoHotSwap: false,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const boot = await bootstrap({
    kernel,
    kernelConfig,
    plugins,
    scheduler,
  });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exitCode = 1;
    return;
  }
  console.log(`bootstrap 成功 (kernel.isReady=${kernel.isReady()})`);

  // 4. 统一 HTTP server (3419): hall + 后端 API 同源
  let hallHandler: ((req: any, res: any) => Promise<void>) | null = null;
  const server = createServer(async (req, res) => {
    // 后端 API 优先 (业务路由), 其余交给 hall
    if (req.url?.startsWith("/app/")) {
      await appBackendHandler(req, res);
      return;
    }
    // 静态页
    if ((req.method === "GET" && (req.url === "/" || req.url === "/index.html"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    // hall 路由 (由 hall 返回的 handler 处理)
    if (hallHandler) {
      await hallHandler(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // 5. 启动多功能对话厅 (hall, 注入 server 同源)
  const hallCtx = kernel.createContext("appbase-hall", LayerId.Infrastructure);
  const hallResolved = await kernel.registry.resolve({
    id: "@infrastructure/hall",
    versionRange: "^1.0.0",
  });
  if (!hallResolved.ok) {
    console.error("resolve hall 失败:", hallResolved.error);
    process.exit(1);
  }
  const hallStart = await hallResolved.value.execute({
    port: APP_PORT,
    server,  // 注入统一 server
    roles: [
      { id: "@persona/codex-chat", name: "Codex 网页应用生成器", emoji: "🪶" },
      { id: "@persona/sales-chat", name: "销售客服", emoji: "💼" },
      { id: "@persona/plugin-helper", name: "插件助手", emoji: "🧩" },
      { id: "@persona/coder", name: "编码助手", emoji: "👨💻" },
    ],
  }, hallCtx);
  if (!hallStart.ok) {
    console.error("hall 启动失败:", hallStart.error);
    process.exit(1);
  }
  // 拿 hall 的 handler (注入模式返回)
  const hallValue = hallStart.value as { handler?: (req: any, res: any) => Promise<void> };
  hallHandler = hallValue.handler ?? null;

  // 6. 监听 3419
  await new Promise<void>((resolve) => server.listen(APP_PORT, "0.0.0.0", () => resolve()));
  console.log(`AppBase 已就绪: http://127.0.0.1:${APP_PORT}/hall (对话厅)`);
  console.log(`                http://127.0.0.1:${APP_PORT}/app/apps (后端 API)`);

  // 7. 启动 AI 网关 (http-ingress, 3418)
  const gwCtx = kernel.createContext("appbase-gateway", LayerId.Infrastructure);
  const gwResolved = await kernel.registry.resolve({
    id: "@infrastructure/http-ingress",
    versionRange: "^1.0.0",
  });
  if (!gwResolved.ok) {
    console.error("resolve http-ingress 失败:", gwResolved.error);
    process.exit(1);
  }
  const gwStart = await gwResolved.value.execute({
    port: GATEWAY_PORT,
    devPaths: ["/v1/chat/completions", "/v1/messages", "/v1/responses"],
    agentPaths: ["/api/chat"],
  }, gwCtx);
  if (!gwStart.ok) {
    console.error("网关启动失败:", gwStart.error);
    process.exit(1);
  }
  console.log(`AI 网关已就绪: http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`);

  // 优雅退出
  const onSigint = async () => {
    await shutdown(kernel, scheduler);
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  await new Promise<void>((resolve) => process.on("SIGTERM", resolve));
}

// 首页 (跳转对话厅 + 产品简介)
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AppBase</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { text-align: center; padding: 48px; border: 1px solid #334155; border-radius: 16px; background: #1e293b; }
  h1 { margin: 0 0 12px; font-size: 32px; }
  p { color: #94a3b8; margin: 8px 0; }
  a { display: inline-block; margin-top: 20px; padding: 12px 28px; background: #2563eb; color: #fff; border-radius: 10px; text-decoration: none; font-weight: 600; }
  a:hover { background: #1d4ed8; }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ AppBase</h1>
    <p>对话创建网页应用 · 一键分发 · 多租户数据</p>
    <a href="/hall">进入对话厅 →</a>
  </div>
</body>
</html>`;

main().catch((e) => { console.error(e); process.exit(1); });