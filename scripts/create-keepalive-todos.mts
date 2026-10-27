/**
 * 一次性脚本：把「服务保活整改」待办建到飞书对应清单的「P 计划中」分组。
 *
 * 做法（与 review-aware.ts 同源）：
 *   1. tenant_access_token → 列清单 /open-apis/task/v2/tasklists
 *   2. 按 org 名匹配清单（AIGility-Cloud-Innovation）
 *   3. 找/建「P 计划中」分组（sections）
 *   4. 建任务 POST /open-apis/task/v2/tasks（summary + description）
 *   5. 挪进 P 分组 POST /tasks/{guid}/add_tasklist
 *
 * 防重：summary 以 [svc-keepalive] 前缀，已存在则跳过。
 */
import { readFileSync } from "node:fs";
import { userToken } from "./feishu-user-token.mts";

const LIST_NAME = "AIGility-Cloud-Innovation";
const SECTION_P = "P 计划中";
const PREFIX = "[svc-keepalive]";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync("/home/johnny/AI/aigility-harness/.env", "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
const APP_ID = env["FEISHU_APP_ID"]!;
const APP_SECRET = env["FEISHU_APP_SECRET"]!;

async function token(): Promise<string> {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = (await r.json()) as { tenant_access_token?: string; code?: number; msg?: string };
  if (!d.tenant_access_token) throw new Error(`取 token 失败: ${d.code} ${d.msg}`);
  return d.tenant_access_token;
}

let T = "";
async function api(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  const url = new URL(`https://open.feishu.cn${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()) as { code?: number; msg?: string; data?: any };
}

/** 待办清单（标题 + 描述） */
const TODOS: Array<{ key: string; summary: string; description: string }> = [
  {
    key: "T1",
    summary: "服务保活：给 task-loop 加 systemd 启动限流（止损无限重启）",
    description: [
      "执行者：agent",
      "",
      "【背景】",
      "2026-10-27 事故：aigility-feishu-task-loop 每次启动因锁被占用而失败退出，",
      "服务文件配 Restart=always（无启动限流），systemd 每 2 秒重拉一次，累计 140 次，",
      "无上限、无告警，刷爆日志并抢占资源，反复打断正在执行的工人进程。",
      "",
      "【要做的】",
      "给 aigility-feishu-task-loop.service 加启动限流：",
      "  StartLimitIntervalSec=300  （注意：写在 [Unit] 段，不是 [Service]）",
      "  StartLimitBurst=5",
      "效果：5 分钟内失败 5 次即停下进入 failed 等人处理，不再无限重试。",
      "",
      "推荐方案 A（不动原文件，可随时回滚）：",
      "  mkdir -p ~/.config/systemd/user/aigility-feishu-task-loop.service.d",
      "  写入该目录下 override.conf：[Unit] 段加上述两项 + [Service] 段重复 Restart=always/RestartSec=10",
      "  systemctl --user daemon-reload && systemctl --user restart aigility-feishu-task-loop.service",
      "验证：systemctl --user show ... -p StartLimitIntervalUSec -p StartLimitBurst（应 5min / 5）",
      "",
      "顺带：aigility-platform.service 同样是 Restart=on-failure 无限流，建议一并加。",
      "",
      "【参考】docs/systemd启动限流配置-可直接粘贴.md",
    ].join("\n"),
  },
  {
    key: "T2",
    summary: "服务保活：把功能开关显式写进服务配置（消除默认值黑箱）",
    description: [
      "执行者：agent",
      "",
      "【背景】",
      "排查发现 aigility-feishu-task-loop.service 只显式声明 2 个变量",
      "（NODE_ENV、WORKER_TEAM_TIMEOUT_MS），其余功能开关全靠「代码默认值」开启——",
      "代码判定式为「值∈{0,false,off} 停用，未设置=开」。",
      "后果：『配置里没有』≠『功能没开』，而是『功能开着但控制权在代码里』。",
      "风险：想关功能找不到开关；只看配置会得出错误结论；代码改默认值时行为悄悄变化。",
      "",
      "【要做的】",
      "在服务文件的 [Service] 段显式写出当前生效值（值与现状完全相同，行为不变）：",
      "  Environment=TASK_STATE_SCAN=1",
      "  Environment=WORKER_TEAM_INTERVAL_MS=60000",
      "  Environment=OBSTACLE_ANALYST=1",
      "",
      "注意：需先用两种方式交叉验证这些值确实是当前生效值，再写。",
      "",
      "【参考】docs/功能开关对照表.md",
    ].join("\n"),
  },
  {
    key: "T3",
    summary: "运维配置页：去掉任务卡片，点进去直接是配置界面",
    description: [
      "执行者：agent",
      "",
      "【需求（用户 2026-10-27 明确）】",
      "导航栏「项目小助理运维配置」（task-loop-config）页面不要再放任务卡片了，",
      "点进去就是配置界面即可。",
      "",
      "【现状】",
      "前端 examples/aigility-platform/app/src/pages/",
      "  TaskLoopConfigPage.tsx（436 行）— 运维配置页（状态卡/飞书接入/配置卡/功能开关/日志卡/工作流卡）",
      "  TaskLoopBoardPage.tsx（197 行）— 任务看板页（含任务卡片，按工单状态分列）",
      "导航注册见 App.tsx:251（task-loop-config → TaskLoopConfigPage）。",
      "",
      "【要做的】",
      "确认并清理 TaskLoopConfigPage 中若混入的任务卡片类展示，使其纯为配置界面；",
      "任务卡片职责保留在 TaskLoopBoardPage（任务看板页），两页职责清晰分离。",
      "",
      "【参考】两份设计文档中『平台 = 配置与观测面，无保活权』的定位。",
    ].join("\n"),
  },
  {
    key: "T4",
    summary: "运维配置页：接服务健康快照（含 config_effective.source）",
    description: [
      "执行者：agent",
      "",
      "【背景】",
      "《服务保活设计》原则三/四：给用户和 agent 的应是「结构化快照」而非原始日志；",
      "每个生效配置项都必须能回答『这个值从哪来』。",
      "今天排查最大障碍就是：服务文件里没写的开关，到底生效没有？答不上来只能猜。",
      "",
      "【要做的】",
      "平台后端提供 /api/aigility/task-loop/health（或并入现有 status）返回：",
      "  owner / health{state,uptime_s,restarts_1h,last_exit}",
      "  config_effective{ KEY: {value, source} }  ← source ∈ default|env|service-file|ui-override",
      "前端运维配置页展示之，让『谁定的这个值』一眼可见。",
      "",
      "【参考】docs/服务保活设计-所有权唯一化.md 第二、三节",
    ].join("\n"),
  },
  {
    key: "T5",
    summary: "平台健康检查改『验活』：不再凭配置记录判进程存活",
    description: [
      "执行者：agent",
      "",
      "【背景】",
      "本次事故中平台日志出现误导记录：",
      "  [managed-apps] feishu-task-loop 已在运行 (pid=1494441)，跳过拉起",
      "而该 PID 早已不存在 —— 平台是『读配置里记的 PID』判活，不是真的验活，",
      "导致死进程被当活实例，平台以为自己不需要管。",
      "",
      "【要做的】",
      "把 managed-apps / task-loop-manager 的存活判定改为三条件同时成立：",
      "  ① pidAlive(pid)  ② /proc/pid/cmdline 匹配预期  ③ 锁属于该 pid",
      "任一不成立即判 stale 并明确处理，不再凭记录判活。",
      "",
      "【参考】docs/服务保活设计-所有权唯一化.md 原则二",
    ].join("\n"),
  },
  {
    key: "T6",
    summary: "配置真源化：config/services.yaml 生成 systemd unit",
    description: [
      "执行者：agent",
      "",
      "【背景】",
      "《服务保活设计》第三步。当前配置散落在 systemd unit、代码默认值、.env 三处，",
      "『这个值从哪来』无法回答，且平台与 systemd 会互相冲突。",
      "",
      "【要做的】",
      "引入 config/services.yaml 作为唯一真源 → 生成各 systemd unit；",
      "UI 变更走『改 yaml → 生成 unit → daemon-reload + restart』；变更留审计日志。",
      "目标是彻底消除『服务文件里没有但代码默认值开着』的模糊态。",
      "",
      "【参考】docs/服务保活设计-所有权唯一化.md 第三章",
      "",
      "【优先级】低于 T1/T2（前两项是止损，本项是长期治理）",
    ].join("\n"),
  },
];

async function main() {
  T = await userToken();
  console.log("✓ 用户 token 就绪（identity=user，与生产同源）");

  // 1. 找清单
  const lists = await api("GET", "/open-apis/task/v2/tasklists", undefined, {
    page_size: "50", user_id_type: "open_id",
  });
  if (lists.code !== 0) throw new Error(`列清单失败: ${lists.code} ${lists.msg}`);
  const items: Array<{ name?: string; guid?: string }> = lists.data?.items ?? [];
  console.log(`  清单数 ${items.length}: ${items.map((i) => i.name).join(" | ")}`);
  const list = items.find((l) => (l.name ?? "").trim() === LIST_NAME);
  if (!list?.guid) throw new Error(`未找到清单「${LIST_NAME}」`);
  console.log(`✓ 目标清单「${LIST_NAME}」 guid=${list.guid}`);

  // 2. 找/建 P 分组
  const secs = await api("GET", "/open-apis/task/v2/sections", undefined, {
    resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id",
  });
  let pGuid: string | undefined = (secs.data?.items ?? []).find(
    (s: { name?: string; guid?: string }) => (s.name ?? "").trim() === SECTION_P,
  )?.guid;
  if (!pGuid) {
    const cr = await api("POST", "/open-apis/task/v2/sections", {
      name: SECTION_P, resource_type: "tasklist", resource_id: list.guid,
    }, { user_id_type: "open_id" });
    pGuid = cr.data?.section?.guid;
  }
  if (!pGuid) throw new Error("P 分组定位/创建失败");
  console.log(`✓ 「${SECTION_P}」 guid=${pGuid}`);

  // 3. 防重：读清单内已有任务
  const existing = await api("GET", `/open-apis/task/v2/tasklists/${list.guid}/tasks`, undefined, {
    completed: "false", page_size: "100", user_id_type: "open_id",
  });
  const have = new Set(
    (existing.data?.items ?? [])
      .map((t: { summary?: string }) => t.summary ?? "")
      .filter((s: string) => s.startsWith(PREFIX)),
  );
  console.log(`  已存在 ${have.size} 条同类待办`);

  // 4. 逐条建
  for (const td of TODOS) {
    const summary = `${PREFIX} ${td.summary}`;
    if (have.has(summary)) { console.log(`  ⏭ 已存在，跳过：${td.key}`); continue; }
    const cr = await api("POST", "/open-apis/task/v2/tasks", {
      summary,
      description: td.description,
    }, { user_id_type: "open_id" });
    if (cr.code !== 0 || !cr.data?.task?.guid) {
      console.log(`  ❌ ${td.key} 建任务失败: ${cr.code} ${cr.msg}`);
      continue;
    }
    const guid = cr.data.task.guid;
    const mv = await api("POST", `/open-apis/task/v2/tasks/${guid}/add_tasklist`, {
      tasklist_guid: list.guid, section_guid: pGuid,
    }, { user_id_type: "open_id" });
    console.log(`  ${mv.code === 0 ? "✅" : "⚠️ "} ${td.key} ${td.summary} | guid=${guid} ${mv.code === 0 ? "→ P" : `挪P失败:${mv.msg}`}`);
  }
  console.log("\n完成。");
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });