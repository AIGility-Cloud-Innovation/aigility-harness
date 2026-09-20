/**
 * TiMEM FDE 工作台 —— 产品装配（examples/fde-workbench）
 *
 * 一个进程两个端口：
 *   - Web  :1234  静态前端（app/dist），index.html 注入 window.FDE_GATEWAY（网关地址+密钥），前端零配置对接
 *   - 网关 :1235  http-ingress（Bearer 鉴权）：OpenAI 兼容 dev 链路 + FDE agent 链路
 *
 * 深度整合链路（五层全走 Seam，无业务旁路）：
 *   数字员工问答  POST /api/fde-chat → @persona/fde-assistant
 *                 （前端注入工作台实时数据快照 + TiMEM 记忆召回/沉淀节点）
 *                 → @orchestration/workflow-engine → @cognitive/llm-inference
 *                 （payload.stream=true 时网关编码为 OpenAI 兼容 SSE 逐字流式）
 *   方案 Word 导出 POST /api/fde-doc → @action/doc-worker（结构化块 → 服务端 docx，base64 回传下载）
 *
 * 行动类指令（推进线索/创建提醒/生成方案）仍由前端本地识别 + 人在回路确认，
 * 不进模型 —— 这是工作台的人机分工原则。
 */

import "./defaults.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LayerId,
  RunMode,
  bootstrap,
  InProcessScheduler,
} from "@aigility-harness/core";
import type { KernelConfig } from "@aigility-harness/core";

import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { plugin as infrastructurePlugin, stopHttpServer } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";
import { plugin as actionPlugin } from "@aigility-harness/layer-action";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.FDE_WEB_PORT ?? 1234);
const GATEWAY_PORT = Number(process.env.FDE_GATEWAY_PORT ?? 1235);
const PUBLIC_HOST = process.env.FDE_PUBLIC_HOST ?? "127.0.0.1";
const DIST_DIR = resolve(__dirname, "../app/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

async function main(): Promise<void> {
  console.log("=== TiMEM FDE 工作台（数字员工 + 文档工人 + AI 网关）===\n");

  // 1. 内核（原型模式，内存实现）
  const kernel = new InMemoryKernelAdapter();

  // 2. 装配五层插件（fde-assistant 已注册进 layer-persona，doc-worker 已注册进 layer-action）
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
    actionPlugin,
  ];
  console.log("装配插件:");
  for (const p of plugins) {
    console.log(`  - ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  // 3. bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "default",
    autoHotSwap: true,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const boot = await bootstrap({ kernel, kernelConfig, plugins, scheduler });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exitCode = 1;
    return;
  }
  console.log(`bootstrap 成功 (kernel.isReady=${kernel.isReady()})`);

  // 4. AI 网关（http-ingress, :1235）
  const gatewayKey = process.env.FDE_GATEWAY_KEY ?? randomBytes(24).toString("hex");
  const gwCtx = kernel.createContext("fde-gateway", LayerId.Infrastructure);
  const gwResolved = await kernel.registry.resolve({
    id: "@infrastructure/http-ingress",
    versionRange: "^1.0.0",
  });
  if (!gwResolved.ok) {
    console.error("resolve http-ingress 失败:", gwResolved.error);
    process.exitCode = 1;
    return;
  }
  const gwStart = await gwResolved.value.execute(
    {
      port: GATEWAY_PORT,
      bearerToken: gatewayKey,
      devPaths: ["/v1/chat/completions", "/v1/messages"],
      agentPaths: ["/api/fde-chat", "/api/fde-doc"],
      agentRoutes: {
        "/api/fde-chat": "@persona/fde-assistant",
        "/api/fde-doc": "@action/doc-worker",
      },
      ...(process.env.BIGMODEL_API_KEY
        ? {
            modelsUpstream: {
              url: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
              key: process.env.BIGMODEL_API_KEY,
            },
          }
        : {}),
    },
    gwCtx,
  );
  if (!gwStart.ok) {
    console.error("网关启动失败:", gwStart.error);
    process.exitCode = 1;
    return;
  }

  // 5. Web 静态服务（:1234）：app/dist + index.html 注入网关配置（前端零配置）
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let filePath = normalize(join(DIST_DIR, path === "/" ? "index.html" : path));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA 回退：无扩展名的未知路径回 index.html
      filePath = join(DIST_DIR, "index.html");
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("前端产物缺失：先执行 pnpm --filter @aigility-harness/fde-workbench build");
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      // 注入网关配置：前端 getHarnessCfg() 优先读 localStorage，缺省回落到注入值
      const html = readFileSync(filePath, "utf-8");
      const inject = `<script>window.FDE_GATEWAY = { url: "http://${PUBLIC_HOST}:${GATEWAY_PORT}", key: "${gatewayKey}" };</script>`;
      res.writeHead(200, { "Content-Type": type });
      res.end(html.replace("<head>", "<head>\n    " + inject));
      return;
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(filePath));
  });
  await new Promise<void>((r) => server.listen(WEB_PORT, "0.0.0.0", () => r()));

  console.log(`\nFDE 工作台已就绪:`);
  console.log(`  工作台前端:  http://127.0.0.1:${WEB_PORT}/  （打开即用，网关配置已自动注入）`);
  console.log(`  AI 网关:     http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions (OpenAI 兼容, Bearer 鉴权)`);
  console.log(`               /api/fde-chat → @persona/fde-assistant · /api/fde-doc → @action/doc-worker`);
  console.log(`  网关密钥:     ${gatewayKey}`);
  console.log(`  演示账号:     admin/admin123 · zhaopeng/fde123 · chensiyuan/fde123`);
  const llmDesc = process.env.LLM_PROVIDER === "stub"
    ? "stub 降级（未检测到 BIGMODEL_API_KEY / LITELLM_URL，回复带【服务降级】标记）"
    : `${process.env.LLM_PROVIDER} 上游`;
  console.log(`  LLM:         ${llmDesc}`);
  console.log(`\nCtrl+C 退出`);

  // 优雅退出
  const shutdown = async () => {
    await stopHttpServer();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
