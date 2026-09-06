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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { plugin as infrastructurePlugin } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";
import { appBackendHandler, initAppBackend, isKnownGatewayKey } from "./backend.js";

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
    // CORS: 允许生成的网页应用从浏览器跨域调用后端 API
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // 可用编码工具检测 (codex / zcode / claude)
    if (req.method === "GET" && req.url?.startsWith("/app/hall/tools")) {
      const detect = (cmd: string, args: string[], useShell = false) => {
        try {
          const r = spawnSync(cmd, args, { shell: useShell, timeout: 8000, encoding: "utf-8" });
          return { ok: r.status === 0, version: (r.stdout || "").trim().split("\n")[0].slice(0, 60) };
        } catch { return { ok: false, version: "" }; }
      };
      const codex = detect("codex", ["--version"], true);
      const zcode = detect(process.env.ZCODE_NODE_BIN ?? "node", [process.env.ZCODE_CLI_PATH ?? "C:/Program Files/ZCode/resources/glm/zcode.cjs", "--version"]);
      const claude = detect("claude", ["--version"], true);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ tools: [
        { id: "codex", name: "Codex CLI", available: codex.ok, version: codex.version },
        { id: "zcode", name: "ZCode CLI", available: zcode.ok, version: zcode.version },
        { id: "claude", name: "Claude Code", available: claude.ok, version: claude.version },
      ] }));
      return;
    }
    // 应用大厅的文件管理 API: /app/hall/apps (读写 examples/apps 沙箱)
    if (req.url?.startsWith("/app/hall/apps")) {
      await hallAppsHandler(req, res);
      return;
    }
    // 短路径别名: /apps/:name → 打开沙箱应用 (共享 hallAppsHandler, 仅 GET)
    if (req.method === "GET" && req.url?.startsWith("/apps/")) {
      req.url = "/app/hall/apps" + req.url.slice("/apps".length);
      await hallAppsHandler(req, res);
      return;
    }
    // 打开应用时取该应用的网关 Key (自动注入, 应用内无需配置)
    if (req.method === "GET" && req.url?.startsWith("/app/hall/key")) {
      const url2 = new URL(req.url ?? "/", "http://x");
      const appName = url2.searchParams.get("app") ?? "";
      const auth = req.headers.authorization ?? "";
      const userId = auth.startsWith("Bearer ") ? await import("./backend.js").then(m => m.verifyToken(auth.slice(7))) : null;
      if (!userId || !appName) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ key: "" })); return; }
      const key = await import("./backend.js").then(m => m.ensureAppKey(appName, userId));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key }));
      return;
    }
    // 后端 API 优先 (业务路由), 其余交给 hall
    if (req.url?.startsWith("/app/")) {
      await appBackendHandler(req, res);
      return;
    }
    // 编码工作台页
    if (req.method === "GET" && (req.url === "/hall/workbench" || req.url?.startsWith("/hall/workbench?"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WORKBENCH_HTML);
      return;
    }
    // 应用大厅页 (替代原对话厅首页; 对话 API /hall/chat 不受影响)
    if (req.method === "GET" && (req.url === "/hall" || req.url === "/hall/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(APP_HALL_HTML);
      return;
    }
    // 静态页
    if ((req.method === "GET" && (req.url === "/" || req.url === "/index.html"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(APP_HALL_HTML);
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
      { id: "@persona/codex-chat", name: `网页应用生成器 (${process.env.AGENT_DRIVER === "zcode" ? "ZCode" : "Codex"} 驱动)`, emoji: "🪶" },
      { id: "@persona/sales-chat", name: "AppBase 客服", emoji: "🎧" },
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
  // 网关必须鉴权, 防止 LLM Key 被盗刷; 未配置则生成随机密钥并打印
  const gatewayKey = process.env.APPBASE_GATEWAY_KEY ?? randomBytes(24).toString("hex");
  const gwStart = await gwResolved.value.execute({
    port: GATEWAY_PORT,
    bearerToken: gatewayKey,
    tokenVerifier: (t: string) => isKnownGatewayKey(t),
    usageReportUrl: `http://127.0.0.1:${APP_PORT}/app/usage/collect`,
    modelsUpstream: {
      url: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
      key: process.env.BIGMODEL_API_KEY ?? "",
    },
    devPaths: ["/v1/chat/completions", "/v1/messages", "/v1/responses"],
    agentPaths: ["/api/chat"],
  }, gwCtx);
  if (!gwStart.ok) {
    console.error("网关启动失败:", gwStart.error);
    process.exit(1);
  }
  console.log(`AI 网关已就绪: http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions (需 Bearer 鉴权)`);
  console.log(`网关密钥: ${gatewayKey}`);

  // 优雅退出
  const onSigint = async () => {
    await shutdown(kernel, scheduler);
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  await new Promise<void>((resolve) => process.on("SIGTERM", resolve));
}


// ── 应用大厅: 沙箱应用文件管理 ──────────────────────────────────
// 应用 = examples/apps 下的自包含 HTML 文件 (生成器产物 + 内置应用)。
const SANDBOX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps");

function safeAppName(name: string): string | null {
  const base = basename(name);
  if (!/^[\w一-龥-]+\.html$/.test(base) || base.includes("..")) return null;
  return base;
}

async function hallAppsHandler(req: any, res: any): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/app/hall/apps") {
    if (!existsSync(SANDBOX_ROOT)) return json(200, { apps: [] });
    const apps = existsSync(SANDBOX_ROOT)
      ? (await import("node:fs")).readdirSync(SANDBOX_ROOT)
          .filter((f: string) => f.endsWith(".html"))
          .map((f: string) => {
            const st = statSync(join(SANDBOX_ROOT, f));
            return { name: f, size: st.size, mtime: st.mtimeMs };
          })
          .sort((a: any, b: any) => b.mtime - a.mtime)
      : [];
    return json(200, { apps });
  }

  const fileMatch = path.match(/^\/app\/hall\/apps\/([^/]+)$/);
  if (fileMatch) {
    const name = safeAppName(decodeURIComponent(fileMatch[1]));
    if (!name) return json(400, { error: "非法应用文件名" });
    const filePath = join(SANDBOX_ROOT, name);

    if (method === "GET" && !url.searchParams.get("meta")) {
      if (!existsSync(filePath)) return json(404, { error: "应用不存在" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(filePath));
      return;
    }
    if (method === "GET") {
      if (!existsSync(filePath)) return json(404, { error: "应用不存在" });
      return json(200, { name, content: readFileSync(filePath, "utf-8") });
    }
    if (method === "PUT") {
      let body = "";
      for await (const c of req) body += c;
      const parsed = JSON.parse(body || "{}");
      const renameTo = url.searchParams.get("rename");
      if (renameTo) {
        const target = safeAppName(decodeURIComponent(renameTo));
        if (!target) return json(400, { error: "非法新名称" });
        if (!existsSync(filePath)) return json(404, { error: "应用不存在" });
        writeFileSync(join(SANDBOX_ROOT, target), readFileSync(filePath));
        unlinkSync(filePath);
        return json(200, { ok: true, name: target });
      }
      if (typeof parsed.content !== "string") return json(400, { error: "content 必填" });
      writeFileSync(filePath, parsed.content);
      return json(200, { ok: true });
    }
    if (method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.name !== "string" || !safeAppName(parsed.name)) return json(400, { error: "非法应用名" });
      const filePath2 = join(SANDBOX_ROOT, parsed.name);
      if (existsSync(filePath2)) return json(409, { error: "同名应用已存在" });
      writeFileSync(filePath2, parsed.content ?? "");
      return json(201, { ok: true, name: parsed.name });
    }
    if (method === "DELETE") {
      if (!existsSync(filePath)) return json(404, { error: "应用不存在" });
      unlinkSync(filePath);
      return json(200, { ok: true });
    }
  }
  json(404, { error: `hall apps: not found (${method} ${path})` });
}

// 应用大厅页 (产品首页)
const APP_HALL_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app-hall.html"), "utf-8");
// 编码工作台页 (可改代码的对话应用专用)
const WORKBENCH_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workbench.html"), "utf-8");

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