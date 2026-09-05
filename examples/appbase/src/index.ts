/**
 * AppBase 演示装配：多功能对话厅 + AI 网关
 *
 * 展示 AppBase 产品形态:
 *   1. 多功能对话厅 (@infrastructure/hall) —— 框架自带基本前端, 多角色对话入口
 *      角色: codex-chat(会创建应用) / sales-chat / plugin-helper / coder
 *   2. AI 网关 (@infrastructure/http-ingress + protocol-adapter + llm-inference)
 *
 * 运行: cd examples/appbase-demo && pnpm start
 * 访问: http://127.0.0.1:3419/hall  (对话厅)
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
import { plugin as infrastructurePlugin } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";

const HALL_PORT = 3419;
const GATEWAY_PORT = 3418;

async function main(): Promise<void> {
  console.log("=== AppBase 演示（多功能对话厅 + AI 网关）===\n");

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

  // 4. 启动多功能对话厅 (hall)
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
    port: HALL_PORT,
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
  console.log(`对话厅已就绪: http://127.0.0.1:${HALL_PORT}/hall`);

  // 5. 启动 AI 网关 (http-ingress)
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

main().catch((e) => { console.error(e); process.exit(1); });