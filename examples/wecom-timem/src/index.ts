/**
 * 企微机器人 → TiMEM Space 客服 (wecom-timem)
 *
 * 独立接入: 使用另一套企微机器人凭证（botId+secret），角色为 @persona/timem-support。
 *
 * 运行前准备:
 *   1. 企微后台创建「智能机器人」，拿到 botId + secret
 *   2. 将凭证填入本仓库根目录 .env 文件（参考 .env.example）:
 *        WECOM_TIMEM_BOT_ID=xxx
 *        WECOM_TIMEM_BOT_SECRET=xxx
 *   3. 启动: pnpm --filter wecom-timem start
 *   4. 在企微里 @机器人 问「TiMEM Space 怎么用?」→ 客服解答产品问题
 *
 * 装配: infrastructure(wecom-ingress) + persona(timem-support) + orchestration + cognitive
 */
import {
  bootstrap,
  shutdown,
  RunMode,
  InProcessScheduler,
  LayerId,
} from "@aigility-harness/core";
import type { KernelConfig } from "@aigility-harness/core";
import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { plugin as infrastructurePlugin } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";
import { wecomIngressProvider } from "@aigility-harness/layer-infrastructure";
import {
  createPyBridgePlugin,
  loadPyPluginsConfig,
} from "@aigility-harness/py-bridge";
import {
  createTimemMemoryProvider,
  createTimemMemoryWriteProvider,
  timemMemoryService,
  timemMemoryWriteService,
} from "@aigility-harness/layer-cognitive/timem-memory-provider";
import { TimemClient } from "@timem/dsh-plugin-timem";
import { loadEnv } from "./env.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 仓库根 = examples/wecom-guide/src → ../../../ (wecom-guide → examples → aigility-harness)
const REPO_ROOT = resolve(__dirname, "../../../");

async function main(): Promise<void> {
  console.log("=== 企微机器人 → TiMEM Space 客服 ===\n");

  // 1. 加载企业微信凭证（.env 文件: WECOM_TIMEM_BOT_ID / WECOM_TIMEM_BOT_SECRET）
  loadEnv();
  const botId = process.env["WECOM_TIMEM_BOT_ID"] ?? "";
  const secret = process.env["WECOM_TIMEM_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error(
      "缺少凭证: 请在 .env 文件设置 WECOM_TIMEM_BOT_ID / WECOM_TIMEM_BOT_SECRET\n" +
        "（参考根目录 .env.example，企微后台「智能机器人」创建时获取）",
    );
    process.exit(1);
  }

  // 2. 内核（原型模式）
  const kernel = new InMemoryKernelAdapter();

  // 3. 装配: 底座 + Python 桥接 + 认知 + 角色 + 编排（py-bridge 在 orchestration 前注册 → resolve 优先真实引擎）
  const timemClient = new TimemClient({
    apiKey: process.env["TIMEM_API_KEY"] ?? "",
    baseUrl: process.env["TIMEM_BASE_URL"] ?? "https://api.timem.cloud",
  });
  const timemMemoryProvider = createTimemMemoryProvider(timemClient);
  const timemMemoryWriteProvider = createTimemMemoryWriteProvider(timemClient);

  // seamCaller: Python worker 回调 TS Seam (如 @cognitive/timem-memory)
  const seamCaller = async (ref: string, state: unknown): Promise<unknown> => {
    const resolved = await kernel.registry.resolve({ id: ref, versionRange: "^1.0.0" });
    if (!resolved.ok) {
      return { error: `Seam resolve 失败: ${resolved.error}` };
    }
    const provider = resolved.value as {
      execute?: (req: unknown, ctx: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    };
    if (!provider.execute) return { error: `capability ${ref} 无 execute` };
    const run = await provider.execute(state, kernel.createContext(`py-callback:${ref}`, LayerId.Infrastructure));
    return run.ok ? run.value : { error: run.error };
  };

  const pyBridgePlugin = createPyBridgePlugin(
    loadPyPluginsConfig(resolve(REPO_ROOT, "config/py-plugins.json")),
    { seamCaller },
  );
  const plugins = [
    infrastructurePlugin,
    pyBridgePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
  ];
  for (const p of plugins) {
    console.log(`装配 ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  // 4. bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "wecom-guide",
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

  // 4.5 注册 timem-memory provider (只读检索 + 写入, dsh-plugin-timem 封装)
  const reg = await kernel.registry.register(timemMemoryService, timemMemoryProvider);
  if (!reg.ok) {
    console.error("timem-memory 注册失败:", reg.error);
  } else {
    console.log("[timem] @cognitive/timem-memory 已注册 (只读检索)");
  }
  const regW = await kernel.registry.register(timemMemoryWriteService, timemMemoryWriteProvider);
  if (!regW.ok) {
    console.error("timem-memory-write 注册失败:", regW.error);
  } else {
    console.log("[timem] @cognitive/timem-memory-write 已注册 (记忆写入)");
  }

  // 5. 启动企业微信入口 → 全部分组走框架介绍员
  const ctx = kernel.createContext("wecom-guide", LayerId.Infrastructure);
  const start = await wecomIngressProvider.execute(
    {
      botId,
      secret,
      agentRoutes: { "*": "@persona/timem-support" },
      perceptionId: "@persona/timem-support",
    },
    ctx,
  );
  if (!start.ok) {
    console.error("wecom-ingress 启动失败:", start.error);
    process.exit(1);
  }
  const wsInfo = start.value;
  console.log(`\n✅ 企业微信机器人已连接 (botId=${wsInfo.botId})`);
  console.log("   @机器人 问「TiMEM Space 怎么用?」即可获得产品解答\n");

  // 6. 等待退出
  const stopWs = async () => {
    await wsInfo.stop();
    await shutdown(kernel, scheduler);
    process.exit(0);
  };
  process.on("SIGINT", () => void stopWs());
  process.on("SIGTERM", () => void stopWs());
  console.log("按 Ctrl+C 退出");
}

main().catch((e) => {
  console.error("启动异常:", e);
  process.exit(1);
});