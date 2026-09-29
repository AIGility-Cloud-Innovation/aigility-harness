/**
 * 企微机器人 → DSH 会话中继 (wecom-dsh)
 *
 * 在企微上与 harness agent 对话：多轮记忆、headless 调用、/new /session
 * 指令、回复截断全部收敛在 @aigility-harness/dsh-interop 的 session-relay，
 * 本装配只做：加载配置 → 注册中继 → 启动企微入口（三步 glue）。
 *
 * 运行前准备 (examples/wecom-dsh/.env)：
 *   WECOM_DSH_BOT_ID=xxx / WECOM_DSH_BOT_SECRET=xxx
 *   DSH_HOME=...            # 缺省 ~/.dsh
 *   DSH_PERMISSION_MODE=... # 可选
 * 启动: pnpm --filter wecom-dsh start
 *
 * 企微指令:
 *   普通消息            → 转发给 agent（滚动上下文多轮）
 *   /new                → 清空当前聊天的对话历史
 *   /session            → 查看当前聊天保留的轮数
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
import { wecomIngressProvider } from "@aigility-harness/layer-infrastructure";
import {
  createDshSessionRelayProvider,
  dshSessionRelayService,
  dshSessionRelayRef,
  loadDotEnv,
} from "@aigility-harness/dsh-interop";
import os from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");

async function main(): Promise<void> {
  console.log("=== 企微机器人 → DSH 会话中继 (wecom-dsh) ===\n");

  loadDotEnv(resolve(__dirname, "../.env"));
  loadDotEnv(resolve(REPO_ROOT, ".env"));
  const botId = process.env["WECOM_DSH_BOT_ID"] ?? "";
  const secret = process.env["WECOM_DSH_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error("缺少凭证: 请在 .env 设置 WECOM_DSH_BOT_ID / WECOM_DSH_BOT_SECRET");
    process.exit(1);
  }

  // 1. 内核（原型模式）+ 装配
  const kernel = new InMemoryKernelAdapter();
  const plugins = [infrastructurePlugin];
  for (const p of plugins) {
    console.log(`装配 ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "wecom-dsh",
    autoHotSwap: false,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const boot = await bootstrap({ kernel, kernelConfig, plugins, scheduler });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exit(1);
  }

  // 2. 注册会话中继能力（dsh-interop 共享实现；dshRunCli 自动探测 dsh bin.js）
  const dshHome = process.env["DSH_HOME"] || resolve(os.homedir(), ".dsh");
  const extraEnv: Record<string, string> = {};
  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DSH_PERMISSION_MODE"]) {
    const v = process.env[key];
    if (v) extraEnv[key] = v;
  }
  const relay = createDshSessionRelayProvider({
    dshHome,
    cwd: process.env["DSH_CWD"] ?? REPO_ROOT,
    transcriptFile: resolve(__dirname, "../.state/transcripts.json"),
    extraEnv,
  });
  const reg = await kernel.registry.register(dshSessionRelayService, relay);
  if (!reg.ok) {
    console.error("dsh-session-relay 注册失败:", reg.error);
    process.exit(1);
  }
  console.log("[relay] @infrastructure/dsh-session-relay 已注册 (dsh-interop 共享实现)");

  // 3. 启动企业微信入口 → 全部消息路由到会话中继
  const ctx = kernel.createContext("wecom-dsh", LayerId.Infrastructure);
  const start = await wecomIngressProvider.execute(
    {
      botId,
      secret,
      agentRoutes: { "*": dshSessionRelayRef.id },
      perceptionId: dshSessionRelayRef.id,
      thinkingText: "🤖 agent 正在处理…",
    },
    ctx,
  );
  if (!start.ok) {
    console.error("wecom-ingress 启动失败:", start.error);
    process.exit(1);
  }
  console.log(`\n✅ 企业微信机器人已连接 (botId=${start.value.botId})`);
  console.log(`   DSH_HOME=${dshHome}`);
  console.log(`   工作区=${process.env["DSH_CWD"] ?? REPO_ROOT}`);
  console.log("   在企微里 @机器人 说话即可与 harness agent 对话; /new 开新会话\n");

  // 4. 等待退出
  const stopWs = async () => {
    await start.value.stop();
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
