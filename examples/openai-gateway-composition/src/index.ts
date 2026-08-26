/**
 * 组合示例：OpenAI 兼容网关 = 内核装配产物（不是独立包，不是第二条实现）
 *
 * 这是 gateway 拆解后的「归宿」演示：不重复实现任何能力，只用现成插件
 * 装配出一条 OpenAI 兼容的 /v1/chat/completions 网关：
 *
 *   HTTP 请求 → @infrastructure/http-ingress（传输+路由）
 *             → @infrastructure/protocol-adapter（协议翻译，openai-chat 透传）
 *             → @cognitive/llm-inference（llm provider：stub / litellm）
 *             → 响应回传（stream:true 时走 SSE 帧流）
 *
 * 组件全部来自现有 packages/，本文件只有「几行引导代码」——这就是
 * 「契约是主体，插件是过客」：网关能力随插件装配而来，随插件卸载而去。
 *
 * 运行: pnpm --filter @aigility-harness/example-openai-gateway start
 * 或:   cd examples/openai-gateway-composition && pnpm start
 *
 * 验证:
 *   # 非流式
 *   curl -s localhost:3398/v1/chat/completions -H 'Content-Type: application/json' \
 *     -d '{"model":"qwen-turbo","messages":[{"role":"user","content":"你好"}]}'
 *   # 流式 (SSE)
 *   curl -N -s localhost:3398/v1/chat/completions -H 'Content-Type: application/json' \
 *     -d '{"model":"qwen-turbo","stream":true,"messages":[{"role":"user","content":"你好"}]}'
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
import { stopHttpServer } from "@aigility-harness/layer-infrastructure";

const PORT = 3398;

async function main(): Promise<void> {
  console.log("=== OpenAI 兼容网关（装配演示）===\n");

  // 1. 内核（原型模式，内存实现）
  const kernel = new InMemoryKernelAdapter();

  // 2. 装配：只需 底座层(传输+协议适配) + 认知层(llm) 两层插件
  const plugins = [infrastructurePlugin, cognitivePlugin];
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
  const boot = await bootstrap({ kernel, kernelConfig, plugins, scheduler });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exit(1);
  }
  console.log(`bootstrap 成功 (kernel.isReady=${kernel.isReady()})`);

  // 4. 启动 http-ingress（唯一入口）
  const ctx = kernel.createContext("gateway-demo", LayerId.Infrastructure);
  const ingress = await kernel.registry.resolve({ id: "@infrastructure/http-ingress", versionRange: "^1.0.0" });
  if (!ingress.ok) {
    console.error("resolve http-ingress 失败:", ingress.error);
    process.exit(1);
  }
  const start = await ingress.value.execute(
    {
      port: PORT,
      devPaths: ["/v1/chat/completions", "/v1/messages"],
      agentPaths: ["/api/chat"],
    },
    ctx,
  );
  if (!start.ok) {
    console.error("http-ingress 启动失败:", start.error);
    process.exit(1);
  }
  console.log(`网关已就绪: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`  非流式: curl -s ... -d '{"messages":[...]}'`);
  console.log(`  流式:   curl -N -s ... -d '{"stream":true,"messages":[...]}'`);
  console.log("\n按 Ctrl+C 退出\n");

  // 自检：非流式 + 流式各打一发（确认装配链路通）
  const devReq = {
    model: "qwen-turbo",
    messages: [{ role: "user", content: "自我介绍" }],
    max_tokens: 32,
  };
  try {
    const r1 = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(devReq),
    });
    console.log(`[自检-非流式] HTTP ${r1.status}: ${(await r1.text()).slice(0, 180)}`);

    const r2 = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...devReq, stream: true }),
    });
    const sse = await r2.text();
    console.log(`[自检-流式] HTTP ${r2.status} content-type=${r2.headers.get("content-type")}`);
    console.log(`[自检-流式] 帧数=${sse.split("\n").filter((l) => l.startsWith("data: ")).length}, 末尾=[DONE]: ${sse.trimEnd().endsWith("data: [DONE]")}`);
  } catch (e) {
    console.log(`[自检] 请求失败（可能是 llm provider 未就绪）: ${String(e)}`);
  }

  // 保持监听直到 Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });

  // 5. 关闭
  await stopHttpServer();
  const sd = await shutdown(kernel, scheduler);
  console.log("\n=== 网关已关闭 ===", sd.ok ? "" : `(shutdown: ${sd.error})`);
  process.exit(0);
}

// keep ok import referenced (unused in strict TS otherwise)
void ok;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});