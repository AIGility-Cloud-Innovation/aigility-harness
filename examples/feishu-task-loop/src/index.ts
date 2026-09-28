/**
 * feishu-task-loop — 飞书任务管理闭环（单应用：cli_a9e24e913a39dcd6「项目小助理」）
 *
 * 链路：
 *   飞书 @项目小助理/私聊
 *     → D1 @infrastructure/feishu（WebSocket 长连接收消息）
 *     → D5 @persona/feishu-task-assistant（正则意图：飞书任务 + Gitea 工单 + 项目概览）
 *     → D3 @action/feishu-api（用户身份调 Open API，token 自动续期）
 *     → D3 @action/gitea-api（git.aigility.cloud 工单，公共 DNS 绕行 + token 认证）
 *     → 回复（占位消息原地编辑）
 *
 * 定位：项目小助理只【管理协调】飞书任务与 Gitea 工单，不执行任务的具体工作。
 *
 * 运行前准备（仓库根 .env）：
 *   FEISHU_APP_ID=cli_a9e24e913a39dcd6
 *   FEISHU_APP_SECRET=xxx
 *   # 用户身份 token 落盘（首次授权用 npx tsx packages/layer-action/authorize-feishu.ts，app.local.json 里放本应用凭证）
 *   FEISHU_USER_TOKEN_STORE=feishu/user_token.local.json
 *   # Gitea（可选：默认读 ~/.gitea-token 与 TiMEM-AI/timem-platform-backend）
 *   # GITEA_TOKEN=xxx
 *   # GITEA_DEFAULT_REPO=TiMEM-AI/timem-platform-backend
 *
 * 启动：pnpm --filter feishu-task-loop start
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
import { plugin as actionPlugin } from "@aigility-harness/layer-action";
import {
  feishuIngressProvider,
} from "@aigility-harness/layer-infrastructure";
import {
  collectMessage,
  setNotifySend,
  setDispatchNotifySend,
  taskIssueSyncProvider,
  taskPipelineProvider,
} from "@aigility-harness/layer-orchestration";
import { loadEnv, REPO_ROOT } from "./env.js";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  acquireSingletonLock,
  defaultLockPath,
  type SingletonLock,
} from "./singleton.js";

/** 网关机器人 AppID → 任务管理人格 */
const FEISHU_AGENT_ROUTES: Record<string, string> = {
  cli_a9e24e913a39dcd6: "@persona/feishu-task-assistant",
};

async function main(): Promise<void> {
  console.log("=== 飞书任务管理闭环（项目小助理）===\n");

  // 单实例守护：确保同一时刻只有一个运行实例连接飞书（防多实例抢事件）
  const lock: SingletonLock | null = acquireSingletonLock();
  if (!lock) {
    console.error(
      `❌ 已有运行中的实例（锁: ${defaultLockPath()}），拒绝重复启动。\n` +
        `   如确认无实例仍在运行，删除锁文件后重试。`,
    );
    process.exit(1);
  }
  console.log(`🔒 单实例锁已持有: ${defaultLockPath()} (pid=${process.pid})`);

  loadEnv();
  // 相对路径的 token store 以仓库根为基准（pnpm --filter 的 cwd 在子包目录）
  const store = process.env["FEISHU_USER_TOKEN_STORE"];
  if (store && !isAbsolute(store)) {
    process.env["FEISHU_USER_TOKEN_STORE"] = resolvePath(REPO_ROOT, store);
  }
  const appId = process.env["FEISHU_APP_ID"] ?? "";
  const appSecret = process.env["FEISHU_APP_SECRET"] ?? "";
  if (!appId || !appSecret) {
    console.error("缺少凭证: 请在仓库根 .env 设置 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }

  // 1. 内核（原型模式）+ 装配五域插件（action 层含 @action/feishu-api）
  const kernel = new InMemoryKernelAdapter();
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
    actionPlugin,
  ];
  for (const p of plugins) {
    console.log(`装配 ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "feishu-task-loop",
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

  // 2. @action/feishu-api 已由 action 插件在 bootstrap 时注册进 registry（ctx.call 按服务 id 解析）

  // 3. 启动飞书入口 → @persona/feishu-task-assistant（@bot 交互）
  //    同时开 passive 监听：群聊免@消息喂给任务流水线做汇总
  const notifyChatId = process.env["TASK_NOTIFY_CHAT_ID"] ?? "";
  const repos = (process.env["TASK_REPOS"] ?? "TiMEM-AI/TiMEM-Space")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Number(process.env["TASK_PIPELINE_INTERVAL_MS"] ?? "600000");
  // 监听白名单：只收这些群的消息；空 = 收机器人所在的所有群
  const listenChatIds = (process.env["TASK_LISTEN_CHAT_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ctx = kernel.createContext("feishu-task-loop", LayerId.Infrastructure);
  const persona = FEISHU_AGENT_ROUTES[appId] ?? "@persona/feishu-task-assistant";
  const start = await feishuIngressProvider.execute(
    {
      appId,
      appSecret,
      agentRoutes: FEISHU_AGENT_ROUTES,
      perceptionId: persona,
      passive: {
        enabled: true,
        chatIds: listenChatIds.length > 0 ? listenChatIds : undefined,
        onCollect: (m) => collectMessage(m),
      },
    },
    ctx,
  );
  if (!start.ok) {
    console.error("feishu-ingress 启动失败:", start.error);
    process.exit(1);
  }
  // 群播报函数注入流水线（建单播报 / PR 提醒）
  setNotifySend(start.value.send);

  // 4. 启动任务流水线（定时：汇总判定 → 去重建工单 → PR 提醒）
  const pipeline = await taskPipelineProvider.execute(
    {
      repos,
      intervalMs,
      notifyChatId: notifyChatId || undefined,
    },
    ctx,
  );
  if (!pipeline.ok) {
    console.error("task-pipeline 启动失败:", pipeline.error);
    process.exit(1);
  }

  // 5. 启动状态队列扫描（P 加工 + D 派发 + 终态回写；与流水线同节奏）
  setDispatchNotifySend(start.value.send);
  const tasklistName = process.env["FEISHU_TASKLIST_NAME"] ?? "TiMEM-AI";
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  const scanTick = async (): Promise<void> => {
    try {
      const r = await taskIssueSyncProvider.execute(
        { mode: "scan", tasklistName, notifyChatId: notifyChatId || undefined },
        ctx,
      );
      if (r.ok && r.value?.response && r.value.response !== "（本轮无待处理任务）") {
        console.log(`[dispatch-scan] ${r.value.response}`);
      }
    } catch (e) {
      console.error(`[dispatch-scan] tick error: ${String(e)}`);
    }
  };
  await scanTick();
  scanTimer = setInterval(() => void scanTick(), intervalMs);
  console.log(`   状态队列: P 加工（去重+目标核对）→ D 派发（15min 闸门）→ 终态回写 (interval=${intervalMs}ms, tasklist=${tasklistName})`);
  console.log(`\n✅ 飞书机器人已连接 (appId=${appId}) → ${persona}`);
  console.log("   飞书里 @项目小助理：「建任务：xxx」「我的任务」「完成 xxx」");
  console.log("   Gitea 工单：「建工单 @仓库：xxx」「工单列表」「关闭工单 #n」「项目概览」");
  console.log(`   流水线: 监听汇总 → 建工单 → PR 提醒 (interval=${intervalMs}ms, repos=${repos.join(",")})`);
  if (!notifyChatId) console.log("   ⚠️ 未配置 TASK_NOTIFY_CHAT_ID，播报与 PR 提醒已关闭");

  const stop = async () => {
    pipeline.value.stop();
    if (scanTimer) clearInterval(scanTimer);
    await start.value.stop();
    await shutdown(kernel, scheduler);
    lock.release(); // 释放单实例锁（kill -9 无法走这里，由下次启动僵锁自愈接管）
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
