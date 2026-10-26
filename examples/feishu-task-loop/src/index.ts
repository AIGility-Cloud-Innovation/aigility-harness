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
 * 任务流水线（数据面工作流化）：
 *   监听缓冲一批消息 → YAML 工作流执行（examples/feishu-task-loop/workflows/
 *   chat-briefing.yaml，每次触发前重读，改文件即生效）：
 *     collect → summarize(分群 LLM 判定) → dedupe(查重)
 *       → create_task(建飞书任务, enabled 开关) → create_issue(建工单, enabled 开关)
 *       → digest(组装播报) → notify(发 TASK_NOTIFY_CHAT_ID「机器人群」)
 *   现阶段（2026-09-30）两个建单节点 enabled: false = 只整理发摘要，不建任务/工单。
 *   状态队列扫描（P 加工→D 派发→建工单回填）用 TASK_STATE_SCAN=0 整体停用。
 *
 * 定位：项目小助理只【管理协调】飞书任务与 Gitea 工单，不执行任务的具体工作。
 *
 * 运行前准备（仓库根 .env）：
 *   FEISHU_APP_ID=cli_a9e24e913a39dcd6
 *   FEISHU_APP_SECRET=xxx
 *   # 用户身份 token 落盘（首次授权用 npx tsx packages/layer-action/authorize-feishu.ts，app.local.json 里放本应用凭证）
 *   FEISHU_USER_TOKEN_STORE=config/feishu/user_token.local.json
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
  parseChatRepoMap,
  setNotifySend,
  setDispatchNotifySend,
  setManualAlignHook,
  taskIssueSyncProvider,
  taskPipelineProvider,
  projectBriefingProvider,
  startBriefingDigestScheduler,
  setBriefingActivitySink,
  createWorkerTeam,
  startWorkerTeamLoop,
  setPlanGateRegistry,
  setDecisionNotifySend,
  feishuApiRef,
  createPeriodicAligner,
  createFeishuTaskProvider,
  createGiteaIssueProvider,
  SECTION_NAMES,
} from "@aigility-harness/layer-orchestration";
import { makeObstacleAnalystOnResult } from "./obstacle-wiring.js";
import { getSharedRegistry, getReviewCodes, assignReviewCodes } from "./review-aware.js";
import { wireLlmNodes } from "@aigility-harness/appbase/llm-node-store";
import { syncGiteaCompletions } from "./completion-sync.js";
import { runPingcodeStatusSync } from "./pingcode-status-sync-adapter.js";
import { syncPingcodeClosures } from "./pingcode-reverse-sync.js";
import { backfillIssueLinks } from "./issue-link-backfill.js";
import { syncAssignees } from "./assignee-sync.js";
import { remindPendingTasks } from "./review-reminder.js";
import { syncPrDeliveredTasks } from "./pr-board-sync.js";
import { remindStaleTasks } from "./stale-task-reminder.js";
import { getProjectedSection, syncBoardAlignment } from "./board-sync.js";
import { loadEnv, REPO_ROOT } from "./env.js";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { acquireBotLock, botLockPath, type BotSingletonLock } from "@aigility-harness/layer-infrastructure";
import { plugin as reviewAwarePlugin } from "./review-aware.js";

/** 网关机器人 AppID → 任务管理人格（复核感知包装：短码自然语言补要素/放行，其余透传） */
const FEISHU_AGENT_ROUTES: Record<string, string> = {
  cli_a9e24e913a39dcd6: "@persona/review-aware-assistant",
};

async function main(): Promise<void> {
  console.log("=== 飞书任务管理闭环（项目小助理）===\n");
  const recentMessages: string[] = [];

  // 单实例守护：确保同一时刻只有一个运行实例连接飞书（防多实例抢事件）
  // （实现已泛化为 layer-infrastructure 共享 bot-singleton；TASK_LOOP_LOCK_PATH 环境变量仍可覆盖锁路径）
  const lock: BotSingletonLock | null = acquireBotLock("feishu-task-loop", {
    lockPath: process.env["TASK_LOOP_LOCK_PATH"],
  });
  const lockPath = process.env["TASK_LOOP_LOCK_PATH"] ?? botLockPath("feishu-task-loop");
  if (!lock) {
    console.error(
      `❌ 已有运行中的实例（锁: ${lockPath}），拒绝重复启动。\n` +
        `   如确认无实例仍在运行，删除锁文件后重试。`,
    );
    process.exit(1);
  }
  console.log(`🔒 单实例锁已持有: ${lockPath} (pid=${process.pid})`);

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
    reviewAwarePlugin,
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
  //    同时开 passive 监听：群聊免@消息（+可选私聊，TASK_LISTEN_P2P）喂给任务流水线做汇总
  const notifyChatId = process.env["TASK_NOTIFY_CHAT_ID"] ?? "";
  const repos = (process.env["TASK_REPOS"] ?? "TiMEM-AI/TiMEM-Space")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Number(process.env["TASK_PIPELINE_INTERVAL_MS"] ?? "600000");
  // 群 → 候选仓库池（来源群 = 任务归属参考）：条目 `chatId=仓库1|仓库2` 逗号分隔，
  // `org:组织名` 展开该组织全部可访问仓库；未映射的参与群用已映射池的并集
  const chatRepoMap = parseChatRepoMap(process.env["TASK_CHAT_REPO_MAP"]);
  // 监听白名单：只收这些群的消息；空 = 收机器人所在的所有群
  const listenChatIds = (process.env["TASK_LISTEN_CHAT_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // 2026-10-08 负责人定稿：监听所有群聊、不监听人对人的私聊——
  // TASK_LISTEN_CHAT_IDS 留空（= 所有群）+ TASK_LISTEN_P2P=0（私聊不采集）。
  // 若要彻底关闭监听：配一个不存在的群 id 并设 P2P=0（空清单不是关闭开关）。
  const ctx = kernel.createContext("feishu-task-loop", LayerId.Infrastructure);
  const persona = FEISHU_AGENT_ROUTES[appId] ?? "@persona/feishu-task-assistant";
  // 语音收发（TTS/STT）：默认关闭，TASK_VOICE=1 打开。
  // 打开后：群里发语音 → ffmpeg 转 PCM → vosk 转写 → 当文本指令处理；
  //        回复按 TASK_VOICE_REPLY 决定是否附一条语音。
  const voiceEnabled = !["0", "false", "off", ""].includes(
    (process.env["TASK_VOICE"] ?? "").toLowerCase(),
  );
  const voiceReplyMode = (process.env["TASK_VOICE_REPLY"] ?? "prefix") as
    | "always"
    | "prefix";
  const voiceConfig = voiceEnabled
    ? {
        stt: {
          enabled: true,
          language: process.env["TASK_VOICE_LANG"] ?? "zh",
        },
        tts: {
          enabled: true,
          mode: voiceReplyMode,
          voicePrefix: process.env["TASK_VOICE_PREFIX"] ?? "语音：",
          ...(process.env["TASK_VOICE_NAME"] ? { voice: process.env["TASK_VOICE_NAME"] } : {}),
        },
      }
    : undefined;
  const start = await feishuIngressProvider.execute(
    {
      appId,
      appSecret,
      agentRoutes: FEISHU_AGENT_ROUTES,
      perceptionId: persona,
      // 摘要播报群（机器人群）免@指令：回复「确认 N」等核验指令不用 @机器人
      mentionExemptChatIds: notifyChatId ? [notifyChatId] : undefined,
      voice: voiceConfig,
      passive: {
        enabled: true,
        chatIds: listenChatIds.length > 0 ? listenChatIds : undefined,
        // 防回声：排除机器人自身（app open_id 可选配）及其他机器人
        excludeSenderIds: (process.env["TASK_EXCLUDE_SENDER_IDS"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        // 私聊收集（TASK_LISTEN_P2P=1 开启）：私聊报缺陷也进汇总缓冲 →
        // 机器人群摘要；私聊同时仍走指令交互链路（两路并行不冲突）
        collectP2p: !["0", "false", "off"].includes(
          (process.env["TASK_LISTEN_P2P"] ?? "1").toLowerCase(),
        ),
        onCollect: (m) => {
          collectMessage(m);
          recentMessages.push(m.text);
        },
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
  const reverseSyncNotify = notifyChatId
    ? async (text: string) => { await start.value.send(notifyChatId, text); }
    : undefined;

  // 模型节点解析器注入（页面上按节点改模型/参数；节点缺失或 DB 不可达 → 退回 env 兜底）
  await wireLlmNodes();

  // 4. 启动任务流水线（定时：分群汇总判定 → 归属/澄清 → 去重建工单 → PR 提醒）
  // 数据面工作流：一批消息的处理过程与功能开关（建单节点 enabled）都在 YAML 里，
  // 每次触发前重新读取——编辑 workflows/chat-briefing.yaml 即改功能，无需重启
  const workflowEnv = process.env["TASK_WORKFLOW_FILE"];
  const workflowFile = workflowEnv
    ? isAbsolute(workflowEnv)
      ? workflowEnv
      : resolvePath(REPO_ROOT, workflowEnv)
    : resolvePath(REPO_ROOT, "examples/feishu-task-loop/workflows/chat-briefing.yaml");
  const pipeline = await taskPipelineProvider.execute(
    {
      repos,
      chatRepoMap,
      intervalMs,
      notifyChatId: notifyChatId || undefined,
      workflowFile,
      registry: getSharedRegistry(),
      reviewCodeFile: resolvePath(REPO_ROOT, "config/review-session.local.json"),
    },
    ctx,
  );
  if (!pipeline.ok) {
    console.error("task-pipeline 启动失败:", pipeline.error);
    process.exit(1);
  }

  // 4.5 任务台账（config/*.local.json）+ 定期对齐器（默认 10 分钟一拍）
  //     收集归机器人单进程（写者唯一）；scripts/review-session.ts 已降级为只读查询。
  //     每拍：三源收集 → 同体收敛 → 标题重复合并 → 冲突/独占巡检；新任务自动续号发短码。
  const alignCtx = kernel.createContext("feishu-task-loop-align", LayerId.Infrastructure);
  const alignFeishuCall = async (req: Record<string, unknown>) =>
    (await alignCtx.call(feishuApiRef, req)) as {
      ok: boolean;
      value?: { code?: number; msg?: string; data?: unknown };
      error?: string;
    };
  const alignGiteaCall = async (req: Record<string, unknown>) =>
    (await alignCtx.call({ id: "@action/gitea-api", versionRange: "^1.0.0" }, req)) as {
      ok: boolean;
      value?: { status?: number; data?: unknown };
      error?: string;
    };
  const registryRepos = (() => {
    try {
      const reg = JSON.parse(
        readFileSync(resolvePath(REPO_ROOT, "config/project-registry.json"), "utf-8"),
      ) as { projects?: Array<{ gitea_repos?: string[] }> };
      return (reg.projects ?? []).flatMap((p) => p.gitea_repos ?? []);
    } catch {
      return [];
    }
  })();
  const alignIntervalMs = Number(process.env["TASK_ALIGN_INTERVAL_MS"] ?? "1800000");
  // agent 任务免工单链的注入必须在任何扫描启动之前（对齐器 runAtStart=true 且
  // 状态队列扫描先注册先触发；晚注入会让首拍 agent 任务撞「未接登记表」留 P，等下拍才恢复）。
  setPlanGateRegistry(getSharedRegistry());
  const aligner = createPeriodicAligner({
    registry: getSharedRegistry(),
    providers: [
      createFeishuTaskProvider(alignFeishuCall, {
        tasklistNames: [...new Set(registryRepos.map((r) => r.split("/")[0]))],
      }),
      createGiteaIssueProvider(alignGiteaCall, { repos: registryRepos }),
    ],
    intervalMs: alignIntervalMs,
    runAtStart: true,
    onReport: async (rep) => {
      const assigned = assignReviewCodes(getSharedRegistry());
      if (assigned.length > 0) {
        console.log(
          `[align] 新增复核短码: ${assigned.map((a) => `${a.code}「${a.title.slice(0, 20)}」`).join(" / ")}`,
        );
      }
      // ① 完成核对（先于提醒）：工单已关闭 → 台账 review + 飞书挪「C 待测试」+ 留痕
      const synced = await syncGiteaCompletions(getSharedRegistry(), alignGiteaCall, alignFeishuCall);
      if (synced.length > 0) {
        console.log(`[align] 完成核对: ${synced.join(" / ")}`);
      }
      // ①.2 负责人反向同步（2026-10-10 拍板）：体外 assignee 变化 → 台账 assignee_member_id
      const assigneeChanges = await syncAssignees(getSharedRegistry(), alignFeishuCall, alignGiteaCall);
      if (assigneeChanges.length > 0) {
        console.log(`[align] 负责人同步: ${assigneeChanges.join(" / ")}`);
      }
      // ①.5 看板反向对齐：人工挪组 → 台账经合法路径跟随（预期截面防误判）
      const boardChanges = await syncBoardAlignment(getSharedRegistry(), alignFeishuCall);
      if (boardChanges.length > 0) {
        console.log(`[align] 看板反向对齐: ${boardChanges.join(" / ")}`);
      }
      // ①.555 PingCode 反向关单（2026-10-23 用户拍板）：PC 关闭/发布 → 台账 done + 飞书标完成。
      //     必须先于正向 ①.56：同拍内台账先落 done，正向快照 completed=true → 期望关闭 → 现态已关闭只记账不写。
      try {
        const pcClosed = await syncPingcodeClosures(getSharedRegistry(), REPO_ROOT, alignFeishuCall, {
          giteaCall: alignGiteaCall,
          notify: reverseSyncNotify,
          receivedMessages: recentMessages.splice(0),
        });
        if (pcClosed.length > 0) {
          console.log(`[align] PingCode 反向关单: ${pcClosed.join(" / ")}`);
        }
      } catch (e) {
        console.error(`[align] PingCode 反向关单异常: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      // ①.56 PingCode 状态联动（2026-10-23 用户拍板「2要做」）：飞书分组/完成 → PC 卡状态
      //     （P→打开 · D→进行中 · C→已提测 · done→关闭；签名防重，未配凭据静默跳过）
      try {
        const pcChanges = await runPingcodeStatusSync(getSharedRegistry());
        if (pcChanges.length > 0) {
          console.log(`[align] PingCode 状态联动: ${pcChanges.join(" / ")}`);
        }
      } catch (e) {
        console.error(`[align] PingCode 状态联动异常: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      // ①.55 PR 交付看板正向同步（2026-10-13 拍板）：agent 任务终结于 PR——
      //     review（PR 已建）的工人小组任务卡片挪「C 待测试」，与台账待验收对齐
      const prMoved = await syncPrDeliveredTasks(getSharedRegistry(), alignFeishuCall, {
        sendGroup: notifyChatId
          ? async (text) => {
              try {
                await start.value.send(notifyChatId, text);
                return true;
              } catch (e) {
                console.error(`[align] agent 失败播报发送失败: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
                return false;
              }
            }
          : undefined,
        projectedSection: getProjectedSection,
      });
      if (prMoved.length > 0) {
        console.log(`[align] agent 任务看板投影: ${prMoved.join(" / ")}`);
      }
      // ①.6 工单链接回填（2026-10-10 负责人需求）：带工单的任务描述缺
      //     「工单链接：」→ 定期补上（幂等；只补不建，建单归 plan-gate 链路）
      const backfilled = await backfillIssueLinks(
        getSharedRegistry(),
        alignGiteaCall,
        alignFeishuCall,
        [...new Set(registryRepos.map((r) => r.split("/")[0]))],
      );
      if (backfilled.length > 0) {
        console.log(`[align] 工单链接回填: ${backfilled.join(" / ")}`);
      }
      // ①.65 人工任务滞留巡检（2026-10-26）：D 组无 agentd 句柄且 >72h 未动 → 群内 @ 负责人。
      //      只读任务状态/分组，提醒基线独立落盘；首拍静默建立基线。
      if (notifyChatId) {
        const stale = await remindStaleTasks(getSharedRegistry(), {
          sendGroup: async (text) => {
            try {
              await start.value.send(notifyChatId, text);
              return true;
            } catch (e) {
              console.error(`[align] 滞留提醒发送失败: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
              return false;
            }
          },
        });
        if (stale.sent > 0 || stale.baselined > 0) {
          console.log(`[align] 滞留巡检: 发送 ${stale.sent} / 首拍基线 ${stale.baselined} / 失败 ${stale.failed}`);
        }
      }
      // ② 「待你处理」提醒：每天最多一次私信负责人（未绑定飞书则跳过）
      await remindPendingTasks({
        sendDm: async (openId, text) => {
          const r = (await alignCtx.call(feishuApiRef, {
            method: "POST",
            path: "/open-apis/im/v1/messages",
            query: { receive_id_type: "open_id" },
            identity: "tenant",
            body: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
          })) as { ok: boolean; value?: { code?: number } };
          return r.ok && (r.value?.code ?? -1) === 0;
        },
        log: (m) => console.log(m),
      });
      if (rep.conflicts.length > 0 || rep.exclusivity.length > 0) {
        console.warn(`[align] 巡检异常: 冲突 ${rep.conflicts.length} / 独占 ${rep.exclusivity.length}`);
      }
    },
    onError: (e) => console.error(`[align] 对齐失败: ${e.message}`),
  });
  aligner.start();
  console.log(
    `   任务台账: config/*.local.json（对齐器 ${Math.round(alignIntervalMs / 60000)} 分钟/拍，短码已发 ${Object.keys(getReviewCodes()).length} 个）`,
  );

  // 5. 启动状态队列扫描（P 加工 + D 派发 + 终态回写；与流水线同节奏）
  //    TASK_STATE_SCAN=0 整体停用：现阶段 digest-only 不建工单，同时避免
  //    存量 P 任务被补齐归属+执行者后由 plan-gate 自动创建 Gitea 工单
  setDispatchNotifySend(start.value.send);
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  if (["0", "false", "off"].includes((process.env["TASK_STATE_SCAN"] ?? "").toLowerCase())) {
    console.log("   状态队列: 已停用 (TASK_STATE_SCAN=0，现阶段不派发/不回填建工单)");
  } else {
  // 任务归属涉及的 org → 各自的飞书任务清单（org 名 = 清单名），逐清单跑状态闸门。
  // 显式配了 FEISHU_TASKLIST_NAME 则维持旧行为只扫一个清单。
  const orgs = new Set<string>();
  for (const r of repos) orgs.add(r.split("/")[0]);
  for (const pool of Object.values(chatRepoMap)) {
    for (const entry of pool) orgs.add(entry.startsWith("org:") ? entry.slice(4) : entry.split("/")[0]);
  }
  const tasklistNames = process.env["FEISHU_TASKLIST_NAME"]
    ? [process.env["FEISHU_TASKLIST_NAME"]]
    : [...orgs];
  const scanTick = async (): Promise<void> => {
    try {
      const r = await taskIssueSyncProvider.execute(
        { mode: "scan", tasklistNames, notifyChatId: notifyChatId || undefined },
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
  console.log(`   状态队列: P 加工（去重+目标核对）→ D 派发（15min 闸门）→ 终态回写 (interval=${intervalMs}ms, tasklists=${tasklistNames.join(",")})`);

  // 手动对齐钩子（「立即对齐」指令）：不等整点，立刻跑 对齐器一拍 + 状态队列一拍，回执给发起人。
  // 简单互斥防重入（对齐器与 scanTick 均为顺序执行，串行化即可）；TASK_STATE_SCAN=0 时只跑对齐器。
  const manualAlign = async (): Promise<string> => {
    const rep = await aligner.runOnce();
    const parts: string[] = [
      `✅ 对齐完成：收集飞书 ${rep.collected.byProvider["feishu-task"]?.scanned ?? 0}/工单 ${rep.collected.byProvider["gitea-issue"]?.scanned ?? 0}，合并 ${rep.merged.length}，冲突 ${rep.conflicts.length}，独占异常 ${rep.exclusivity.length}`,
    ];
    let scanOut = "";
    if (!["0", "false", "off"].includes((process.env["TASK_STATE_SCAN"] ?? "").toLowerCase())) {
      try {
        const r = await taskIssueSyncProvider.execute(
          { mode: "scan", tasklistNames, notifyChatId: notifyChatId || undefined },
          ctx,
        );
        scanOut = r.ok ? (r.value?.response ?? "") : `⚠️ 状态队列扫描失败：${r.error}`;
      } catch (e) {
        scanOut = `⚠️ 状态队列扫描异常：${String((e as Error)?.message ?? e)}`;
      }
    }
    if (scanOut && scanOut !== "（本轮无待处理任务）") parts.push(scanOut);
    else if (!scanOut) parts.push("状态队列：已停用（TASK_STATE_SCAN=0）");
    return parts.join("\n");
  };
  setManualAlignHook(manualAlign);
  console.log("   手动对齐: 聊天发「立即对齐」随时触发（对齐器一拍 + 状态队列一拍）");
  }

  // 6. 记忆沉淀（timem）：每日定时快照 + 事件补充（建单/工单关闭等显著变化防抖写入）
  //    身份/项目对齐来自 config/ 两张登记表（平台「身份对齐」页可在线维护，自动生效）
  const briefingCtx = kernel.createContext("feishu-task-loop", LayerId.Orchestration);
  setBriefingActivitySink((projectKey, hint) => {
    void projectBriefingProvider
      .execute({ mode: "write-digest", trigger: "event", project: projectKey, note: hint }, briefingCtx)
      .then((r) => {
        if (r.ok) console.log(`[briefing] 事件快照: ${(r.value?.response ?? "").split("\n")[0]}`);
        else console.error(`[briefing] 事件快照失败: ${r.error}`);
      })
      .catch((e) => console.error(`[briefing] 事件快照异常: ${String(e)}`));
  });
  const digestScheduler = startBriefingDigestScheduler({
    ctx: briefingCtx,
    execute: (req, c) => projectBriefingProvider.execute(req, c),
  });
  console.log("   记忆沉淀: 每日定时快照 + 事件补充 → timem（BRIEFING_DIGEST_TIME 可改触发时刻）");

  // 7. 工人小组（worker-team）：轻型工人接单循环（ready 队列 → claim → @action/*-agent）
  //    只接轻型即发任务；重型（需闸门/审计）仍走 taskIssueSync → agentd 原链路。
  //    WORKER_TEAM_INTERVAL_MS=0 停用；成员可用任务 description 里 [worker:claude] 指定。
  //    收尾器（pr-finisher）默认装配：交付=PR 建成才算 done，通知走机器人群（未配则日志）。
  // 基线解析走四级链（worktree-manager.resolveBaseBranch）：
  // WORKER_TEAM_BASE_BRANCH 显式配置 → origin/HEAD → 仓库当前 HEAD → 兜底 dev。
  // 不在此处硬编码默认值（2026-10-20）：env 优先级最高会短路整条链——
  // nx-telecom（origin/HEAD=develop）等非 dev 主线仓被强打 origin/dev 直接派发失败。
  // 跨仓差异用 origin/HEAD 声明表达（git remote set-head origin -a），不靠启动期一刀切。
  // 决策播报 DM 抄送目标（可选）：决策反问除机器人群外并行发该会话，保证用户看得到
  const decisionDmChatId = process.env["TASK_DECISION_DM_CHAT_ID"] ?? "";
  // 障碍分析员（2026-10-26）：单任务 dispatch 回流即归因（不等整批）；
  // OBSTACLE_ANALYST=0 关闭；回调异常不影响批内后续任务（见 obstacle-wiring）。
  const obstacleOnResult = makeObstacleAnalystOnResult({
    ctx,
    registry: getSharedRegistry(),
    ...(notifyChatId ? { notify: async (text: string) => { await start.value.send(notifyChatId, text); } } : {}),
  });
  const workerTeam = createWorkerTeam({
    ctx,
    registry: getSharedRegistry(),
    onResult: obstacleOnResult,
    // send 返回 Promise<string|void>，收尾器 notify 只需 Promise<void>——包装丢弃返回值
    ...(notifyChatId ? { notify: async (text: string) => { await start.value.send(notifyChatId, text); } } : {}),
    // 决策播报：机器人群 + 可选 DM 抄送（2026-10-19 修复静默丢失）
    ...((notifyChatId || decisionDmChatId)
      ? {
          decision: {
            notify: async (text: string) => {
              if (notifyChatId) await start.value.send(notifyChatId, text);
              if (decisionDmChatId && decisionDmChatId !== notifyChatId) {
                await start.value.send(decisionDmChatId, text);
              }
            },
          },
        }
      : {}),
  });
  const teamLoop = startWorkerTeamLoop({ team: workerTeam });

  // 7.5 agent 任务免工单链（2026-10-13 拍板）：plan-gate 加工 P 组的 agent 任务时
  //     直接写共享台账并放行 ready（不建工单、不挪 D），工人小组经同一登记表认领。
  setPlanGateRegistry(getSharedRegistry());
  // 决策回复通道（耳朵，2026-10-19）：「决策 任务号 选项」→ 写决策文件 → 重入队 → worker-team 续跑；
  // 回执经响应回来源会话，此处把同文镜像播报机器人群（与决策反问同通道；未配置则不镜像）
  if (notifyChatId) {
    setDecisionNotifySend(async (text: string) => {
      await start.value.send(notifyChatId, text);
    });
  }

  console.log(`\n✅ 飞书机器人已连接 (appId=${appId}) → ${persona}`);
  console.log("   飞书里 @项目小助理：「建任务：xxx」「我的任务」「完成 xxx」");
  console.log("   Gitea 工单：「建工单 @仓库：xxx」「工单列表」「关闭工单 #n」「项目概览」");
  console.log("   群归属：「任务归属 编号 @仓库」确认澄清，「跳过任务 编号」丢弃");
  console.log(`   流水线: 监听群 → 数据面工作流(workflows/chat-briefing.yaml, 节点 enabled 即功能开关) → 播报${notifyChatId ? "机器人群" : "回来源群"} (interval=${intervalMs}ms, repos=${repos.join(",")}, 映射群=${Object.keys(chatRepoMap).length}${["0", "false", "off"].includes((process.env["TASK_LISTEN_P2P"] ?? "1").toLowerCase()) ? "" : ", 私聊收集=开"})`);
  if (!notifyChatId) console.log("   ⚠️ 未配置 TASK_NOTIFY_CHAT_ID，播报与 PR 提醒已关闭");

  const stop = async () => {
    pipeline.value.stop();
    if (scanTimer) clearInterval(scanTimer);
    digestScheduler?.stop();
    teamLoop.stop();
    setBriefingActivitySink(undefined);
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
