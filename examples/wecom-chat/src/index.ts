/**
 * 企微机器人 → 通用 AI 助手 (wecom-chat)
 *
 * 只用现有资源装配: infrastructure(wecom-ingress) + persona(通用对话角色) + cognitive。
 * 默认路由到 @persona/sales-chat（平台客服型通用对话），
 * 可用环境变量切换为任意现有角色:
 *   WECOM_CHAT_PERSONA=@persona/coding-coach   # 编码教练
 *   WECOM_CHAT_PERSONA=@persona/harness-guide  # 框架介绍员
 *   WECOM_CHAT_PERSONA=@persona/app-dev        # 网页应用开发员(→codex, 同 wecom-coder)
 * 可选按群路由: WECOM_CHAT_ROUTES={"<chatid>":"@persona/xxx"} (JSON)
 *
 * 运行前准备:
 *   1. 企微后台创建「智能机器人」，拿到 botId + secret
 *   2. 仓库根 .env 写入:
 *        WECOM_CHAT_BOT_ID=xxx
 *        WECOM_CHAT_BOT_SECRET=xxx
 *   3. 启动: pnpm --filter wecom-chat start
 *   4. 在企微群里 @机器人 说话 → AI 回复（支持 Markdown）
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
import { loadEnv } from "./env.js";

const DEFAULT_PERSONA = "@persona/sales-chat";

function parseRoutes(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    console.warn(`[wecom-chat] WECOM_CHAT_ROUTES 不是合法 JSON, 忽略: ${raw}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log("=== 企微机器人 → 通用 AI 助手 (wecom-chat) ===\n");

  // 1. 凭证（.env 或环境变量）
  loadEnv();
  const botId = process.env["WECOM_CHAT_BOT_ID"] ?? "";
  const secret = process.env["WECOM_CHAT_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error(
      "缺少凭证: 请在仓库根 .env 设置 WECOM_CHAT_BOT_ID / WECOM_CHAT_BOT_SECRET\n" +
        "（企微后台「智能机器人」创建时获取）",
    );
    process.exit(1);
  }

  // 2. 角色路由: 默认全部 → 通用对话角色; 可按群覆盖
  const defaultPersona = process.env["WECOM_CHAT_PERSONA"] || DEFAULT_PERSONA;
  const agentRoutes = { ...(parseRoutes(process.env["WECOM_CHAT_ROUTES"]) ?? {}) };
  agentRoutes["*"] = defaultPersona;

  // 3. 内核（原型模式）+ 装配
  const kernel = new InMemoryKernelAdapter();
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
    profile: "wecom-chat",
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

  // 5. 启动企业微信入口
  const ctx = kernel.createContext("wecom-chat", LayerId.Infrastructure);
  const start = await wecomIngressProvider.execute(
    { botId, secret, agentRoutes, perceptionId: defaultPersona },
    ctx,
  );
  if (!start.ok) {
    console.error("wecom-ingress 启动失败:", start.error);
    process.exit(1);
  }
  const wsInfo = start.value;
  console.log(`\n✅ 企业微信机器人已连接 (botId=${wsInfo.botId})`);
  console.log(`   默认角色: ${defaultPersona}`);
  console.log("   在企微群里 @机器人 说话即可交流\n");

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
