/**
 * 特色案例: 企业微信 @机器人 → @persona/coder → codex（经框架认知层）
 *
 * 运行前准备:
 *   1. 企微后台创建「智能机器人」，拿到 botId + secret
 *   2. 配置环境变量 WECOM_BOT_ID / WECOM_BOT_SECRET（或本文件直接传入）
 *   3. 启动: pnpm --filter wecom-coder start
 *   4. 在企微群里 @机器人 说"帮我写个排序算法" → codex 干活 → 回复
 *
 * 装配: infrastructure(wecom-ingress + bridge) + persona(coder) + orchestration(codex-agent)
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

async function main(): Promise<void> {
  console.log("=== 特色案例: 企业微信 → coder → Codex ===\n");

  const botId = process.env["WECOM_BOT_ID"] ?? "";
  const secret = process.env["WECOM_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error(
      "缺少凭证: 请设置 WECOM_BOT_ID / WECOM_BOT_SECRET 环境变量" +
        "（企微后台「智能机器人」创建时获取）",
    );
    process.exit(1);
  }

  // 1. 内核（原型模式）
  const kernel = new InMemoryKernelAdapter();

  // 2. 装配: 底座 + 认知 + 角色 + 编排（coder → codex-agent → codex）
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
  ];
  for (const p of plugins) {
    console.log(`装配 ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  // 3. bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "wecom-coder",
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

  // 4. 启动企业微信入口
  const ctx = kernel.createContext("wecom-coder", LayerId.Infrastructure);
  const start = await wecomIngressProvider.execute(
    { botId, secret },
    ctx,
  );
  if (!start.ok) {
    console.error("wecom-ingress 启动失败:", start.error);
    process.exit(1);
  }
  const wsInfo = start.value;
  console.log(`\n✅ 企业微信机器人已连接 (botId=${wsInfo.botId})`);
  console.log("   @机器人 说「帮我写个 …」即可驱动 codex 干活\n");

  // 5. 等待退出
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