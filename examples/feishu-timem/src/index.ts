/**
 * 飞书机器人 → TiMEM Project 项目小助手 (feishu-timem)
 *
 * 多机器人共用一个飞书 ingress（gateway），通过 agentRoutes 的识别配置
 * 决定消息路由到哪个人格角色：
 *
 *   cli_a9e24e913a39dcd6（项目小助手）→ @persona/timem-project-assistant
 *   （新增机器人时，在 agentRoutes 增加一行 AppID → persona 映射即可）
 *
 * 运行前准备:
 *   1. 飞书开放平台创建应用，开启机器人能力；事件订阅选「长连接」模式
 *   2. 将凭证填入 .env（参考根目录 .env.example）:
 *        FEISHU_APP_ID=cli_a9e24e913a39dcd6
 *        FEISHU_APP_SECRET=xxx
 *   3. 启动: pnpm --filter feishu-timem start
 *   4. 在飞书里 @机器人 发任务指令 → 项目小助手人格 → codex 执行
 *
 * 装配: infrastructure(feishu-ingress) + persona(timem-project-assistant)
 *        + orchestration + cognitive
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
import { plugin as orchestrationPlugin, enableTimemTask, timemTaskService, timemTaskProvider } from "@aigility-harness/layer-orchestration";
import { feishuIngressProvider } from "@aigility-harness/layer-infrastructure";
import { loadEnv } from "./env.js";

/**
 * 飞书机器人 → 人格角色 映射表（gateway 识别配置）
 * 新增机器人：在此登记一行 { appId: "@persona/xxx" } 即可复用同一 ingress。
 */
const FEISHU_AGENT_ROUTES: Record<string, string> = {
  // 项目小助手（timem-project 任务执行）
  cli_a9e24e913a39dcd6: "@persona/timem-project-assistant",
};

async function main(): Promise<void> {
  console.log("=== 飞书机器人 → TiMEM Project 项目小助手 ===\n");

  // 1. 加载飞书凭证（.env 文件: FEISHU_APP_ID / FEISHU_APP_SECRET）
  loadEnv();
  const appId = process.env["FEISHU_APP_ID"] ?? "";
  const appSecret = process.env["FEISHU_APP_SECRET"] ?? "";
  if (!appId || !appSecret) {
    console.error("缺少凭证: 请在 .env 文件设置 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }

  // 2. 内核（原型模式）
  const kernel = new InMemoryKernelAdapter();

  // 3. 装配四层插件
  const plugins = [
    infrastructurePlugin,
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
    profile: "feishu-timem",
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

  // 4.5 接线 timem-task：真实执行桥接（UDS → agentd → codex）
  //     socket/token 从 env 读；agentd 未起时 timem-task 会降级报错
  enableTimemTask({
    socketPath: process.env["TIMEM_AGENTD_SOCK"],
    token: process.env["TIMEM_AGENTD_TOKEN"],
  });
  const timemReg = await kernel.registry.register(timemTaskService, timemTaskProvider);
  if (timemReg.ok) {
    console.log("[timem-task] 真实执行桥接已注册 (UDS → agentd)");
  } else {
    console.error("[timem-task] 注册失败:", timemReg.error);
  }

  // 5. 启动飞书入口 → 按 AppID 路由到对应人格
  const ctx = kernel.createContext("feishu-timem", LayerId.Infrastructure);
  const persona = FEISHU_AGENT_ROUTES[appId] ?? "@persona/timem-project-assistant";
  const start = await feishuIngressProvider.execute(
    {
      appId,
      appSecret,
      agentRoutes: FEISHU_AGENT_ROUTES,
      perceptionId: persona,
    },
    ctx,
  );
  if (!start.ok) {
    console.error("feishu-ingress 启动失败:", start.error);
    process.exit(1);
  }
  console.log(`\n✅ 飞书机器人已连接 (appId=${appId}) → ${persona}`);
  console.log("   在飞书里 @机器人 发任务指令即可\n");

  // 6. 等待退出
  const stop = async () => {
    await start.value.stop();
    await shutdown(kernel, scheduler);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  console.log("按 Ctrl+C 退出");
}

main().catch((e) => {
  console.error("启动异常:", e);
  process.exit(1);
});