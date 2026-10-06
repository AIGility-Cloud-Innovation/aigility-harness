/**
 * review-reminder — 「待你处理」主动提醒（防抖：计数变化或每天最多一次）
 *
 * 触发顺序（每拍）：完成核对（completion-sync）→ 本提醒。提醒读的是核对后
 * 的最新状态，僵尸任务不可能出现。
 *
 * 分类（负责人 2026-10-04 确认的三类）：
 *   · 待验收：已放行（ready/dispatched/running）的任务；
 *   · 缺执行人：回复「R0x 执行人 姓名」；
 *   · 缺归属：回复「任务归属 R0x 仓库」。
 *
 * 通道：私信负责人（member-johnny 绑定的飞书 open_id）；未绑定则跳过
 * 并打日志（避免把个人提醒发全员群），发「绑定身份 johnny」即开启。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedRegistry, getReviewCodes } from "./review-aware.js";
import { getProjectedSection } from "./board-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATE_FILE = process.env["REVIEW_REMINDER_STATE_FILE"] ?? join(ROOT, "config", "review-reminder.local.json");

interface ReminderState {
  lastSentDate?: string;
  lastCounts?: { released: number; missingExecutor: number; missingProject: number };
}

function loadState(): ReminderState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ReminderState;
  } catch {
    return {};
  }
}

function saveState(s: ReminderState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function loadJohnnyOpenId(): string | undefined {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, "config/timem-team-registry.json"), "utf-8")) as {
      members?: Array<{ member_id: string; feishu_open_ids?: string[] }>;
    };
    return reg.members?.find((m) => m.member_id === "member-johnny")?.feishu_open_ids?.[0];
  } catch {
    return undefined;
  }
}

export interface ReminderContext {
  /** 私信发送（feishu tenant send，receive_id_type=open_id） */
  sendDm: (openId: string, text: string) => Promise<boolean>;
  /** 兜底群播报（负责人未绑定时跳不用，仅日志） */
  log: (msg: string) => void;
  now?: () => Date;
}

/** 台账状态 → PDCA 看板语言 */
const PDCA_OF: Record<string, string> = {
  planned: "P·规划中",
  ready: "P·已放行",
  dispatched: "D·执行中",
  running: "D·执行中",
  review: "C·待测试",
  failed: "A·待修复",
  blocked: "blocked",
  cancelled: "已取消",
  done: "已完成",
};

function taskLine(code: string, r: { uid: string; status: string; title: string; projectRef?: string }): string {
  // PDCA 以看板实际截面为优先（人工挪组已反向同步），无截面记录时回退台账状态
  const sec = getProjectedSection(r.uid);
  const pdca = (sec && ({ P: "P·规划中", D: "D·执行中", C: "C·待测试", A: "A·待修复" } as Record<string, string>)[sec]) || PDCA_OF[r.status] || r.status;
  const repo = r.projectRef ?? "（未定仓库）";
  const title = r.title.replace(/^\[[^\]]+\]\s*/, "").replace(/^【[^】]+】/, "").slice(0, 36);
  return `  - ${code}［${pdca}｜${repo}］${title}`;
}

export async function remindPendingTasks(ctx: ReminderContext): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const today = now().toISOString().slice(0, 10);
  const registry = getSharedRegistry();
  const codes = getReviewCodes();
  const codeOf = (uid: string): string =>
    Object.entries(codes).find(([, u]) => u === uid)?.[0] ?? "—";

  const released = registry.list({ status: ["ready", "dispatched", "running"] });
  const planned = registry.list({ status: ["planned"] });
  const missingExecutor = planned.filter((t) => !/执行者：\S+/.test(t.description ?? ""));
  const missingProject = planned.filter((t) => !t.projectRef);
  const counts = {
    released: released.length,
    missingExecutor: missingExecutor.length,
    missingProject: missingProject.length,
  };
  const total = counts.released + counts.missingExecutor + counts.missingProject;
  if (total === 0) {
    const s = loadState();
    if (s.lastSentDate === today) saveState({ ...s, lastCounts: counts });
    return;
  }

  const state = loadState();
  // 频率语义（负责人确认）：每天最多一次；当天首拍即发（计数变化与否都给当日快照）
  const alreadyToday = state.lastSentDate === today;
  if (alreadyToday) return;

  const lines: string[] = [`📌 有 ${total} 条任务等你处理：`];
  if (released.length) {
    lines.push("", `已放行待验收 ${released.length} 条：`);
    for (const r of released) lines.push(taskLine(codeOf(r.uid), r));
  }
  if (missingExecutor.length) {
    lines.push("", `缺执行人 ${missingExecutor.length} 条（回复「R0x 执行人 姓名」）：`);
    for (const r of missingExecutor.slice(0, 5)) lines.push(taskLine(codeOf(r.uid), r));
    if (missingExecutor.length > 5) lines.push(`  …另有 ${missingExecutor.length - 5} 条`);
  }
  if (missingProject.length) {
    lines.push("", `缺归属 ${missingProject.length} 条（回复「任务归属 R0x 仓库」）：`);
    for (const r of missingProject.slice(0, 5)) lines.push(taskLine(codeOf(r.uid), r));
    if (missingProject.length > 5) lines.push(`  …另有 ${missingProject.length - 5} 条`);
  }
  lines.push("", "（每天最多提醒一次；处理完自动停止提醒）");

  const openId = loadJohnnyOpenId();
  if (!openId) {
    ctx.log("[reminder] 跳过私信：johnny 未绑定飞书（发「绑定身份 johnny」开启提醒）");
    saveState({ lastSentDate: today, lastCounts: counts });
    return;
  }
  const sent = await ctx.sendDm(openId, lines.join("\n"));
  if (sent) {
    saveState({ lastSentDate: today, lastCounts: counts });
    ctx.log(`[reminder] 已私信提醒（${total} 条待处理）`);
  } else {
    ctx.log("[reminder] 私信发送失败，下拍重试");
  }
}
