/**
 * 飞书机器人 → DSH 会话中继 (feishu-dsh)
 *
 * 在飞书上与 harness agent 对话：多轮记忆、headless 调用、/new /session
 * 指令、回复截断全部收敛在 @aigility-harness/dsh-interop 的 session-relay，
 * 本装配只做：加载配置 → 注册中继 → 启动飞书入口（三步 glue）。
 *
 * ⚠️ 机器人身份归属：cli_a9e24e913a39dcd6 是「项目小助理」
 * （feishu-task-loop）的应用，不要混用。DSH 应使用独立的飞书应用——
 * 在 examples/feishu-dsh/.env 配置该应用的 FEISHU_APP_ID / FEISHU_APP_SECRET
 * （先于仓库根 .env 加载，先到先得，不会污染小助理的凭据）。
 *
 * 运行前准备 (examples/feishu-dsh/.env)：
 *   FEISHU_APP_ID=cli_xxx    # DSH 专用飞书应用（机器人能力 + 长连接订阅）
 *   FEISHU_APP_SECRET=xxx
 *   DSH_HOME=...             # 缺省 ~/.dsh
 * 启动: pnpm --filter feishu-dsh start
 *
 * 飞书指令:
 *   普通消息（群内需 @机器人）→ 转发给 agent（滚动上下文多轮）
 *   /new                     → 清空当前聊天的对话历史
 *   /session                 → 查看当前聊天保留的轮数
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
import { feishuIngressProvider } from "@aigility-harness/layer-infrastructure";
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
  console.log("=== 飞书机器人 → DSH 会话中继 (feishu-dsh) ===\n");

  // 先 example 私有 .env（DSH 专用机器人凭据），再仓库根 .env；先到先得
  loadDotEnv(resolve(__dirname, "../.env"));
  loadDotEnv(resolve(REPO_ROOT, ".env"));
  const appId = process.env["FEISHU_APP_ID"] ?? "";
  const appSecret = process.env["FEISHU_APP_SECRET"] ?? "";
  if (!appId || !appSecret) {
    console.error("缺少凭证: 请设置 FEISHU_APP_ID / FEISHU_APP_SECRET（examples/feishu-dsh/.env）");
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
    profile: "feishu-dsh",
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
    // 角色能力注册表（Phase 2）：role → skills/MCP，每条消息热读取
    roleRegistryFile: resolve(__dirname, "../roles.json"),
  });
  const reg = await kernel.registry.register(dshSessionRelayService, relay);
  if (!reg.ok) {
    console.error("dsh-session-relay 注册失败:", reg.error);
    process.exit(1);
  }
  console.log("[relay] @infrastructure/dsh-session-relay 已注册 (dsh-interop 共享实现)");

  // 3. 启动飞书入口 → 全部消息路由到会话中继
  const ctx = kernel.createContext("feishu-dsh", LayerId.Infrastructure);
  const start = await feishuIngressProvider.execute(
    {
      appId,
      appSecret,
      agentRoutes: { "*": dshSessionRelayRef.id },
      perceptionId: dshSessionRelayRef.id,
      thinkingText: "🤖 agent 正在处理…",
    },
    ctx,
  );
  if (!start.ok) {
    console.error("feishu-ingress 启动失败:", start.error);
    process.exit(1);
  }
  console.log(`\n✅ 飞书机器人已连接 (appId=${appId}) → dsh headless`);
  console.log(`   DSH_HOME=${dshHome}`);
  console.log(`   工作区=${process.env["DSH_CWD"] ?? REPO_ROOT}`);
  console.log("   在飞书里私聊/@机器人 说话即可与 harness agent 对话; /new 开新会话\n");

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
