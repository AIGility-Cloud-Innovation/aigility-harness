/**
 * stale-task-reminder — 人工任务滞留巡检（对齐器每拍执行）
 *
 * 范围：台账 status=dispatched（看板 D 执行中）且没有 agentd 执行句柄的记录。
 * 判定：now - updatedAt > 72 小时。动作：群内提醒并 @ 负责人；不改状态、不挪分组。
 *
 * 防重复：
 *   · 首拍只把存量滞留写入基线，不发送（避免上线瞬间全量误报）；
 *   · 同一任务同一停顿只提醒一次；
 *   · 负责人变更或任务推进后再次停滞 72 小时 → 允许再次提醒。
 * 提醒状态独立落盘，绝不回写台账 updatedAt（否则会自己把滞留计时清零）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTD_TASK_PROVIDER_ID,
  getIdentityRegistry,
  identityMembers,
} from "@aigility-harness/layer-orchestration";
import type { IdentityMember } from "@aigility-harness/layer-orchestration";
import type { TaskRecord, UnifiedStatus } from "@aigility-harness/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_STATE_FILE = join(ROOT, "config", "stale-task-reminder.local.json");

export const STALE_TASK_THRESHOLD_MS = 72 * 60 * 60_000;

interface StaleTaskStateEntry {
  /** 最近一次提醒（或首跑基线）时间，毫秒时间戳 */
  staleNotifiedAt: number;
  /** 该次提醒对应的台账 updatedAt；之后推进再停滞可重新提醒 */
  notifiedForUpdatedAt: number;
  /** 该次提醒对应的负责人 member_id；负责人变更可重新提醒 */
  assignee: string;
}

interface StaleTaskState {
  initializedAt?: number;
  tasks: Record<string, StaleTaskStateEntry>;
}

export interface StaleTaskReminderOptions {
  /** 群发送；返回 false 时不记为已提醒，下拍重试 */
  sendGroup: (text: string) => Promise<boolean>;
  /** 状态文件（测试注入） */
  stateFile?: string;
  /** 当前时间（测试注入） */
  now?: () => Date;
  /** 阈值毫秒（测试注入；生产固定 72h） */
  thresholdMs?: number;
  /** 人员台账（测试注入；生产读 config/timem-team-registry.json） */
  members?: IdentityMember[];
}

export interface StaleTaskReminderResult {
  /** 首拍写入基线的任务数（未发送） */
  baselined: number;
  /** 本轮实际发送数 */
  sent: number;
  /** 发送失败待下拍重试数 */
  failed: number;
}

function loadState(file: string): StaleTaskState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<StaleTaskState>;
    return { initializedAt: raw.initializedAt, tasks: raw.tasks ?? {} };
  } catch {
    return { tasks: {} };
  }
}

function saveState(file: string, state: StaleTaskState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function hasAgentdHandle(t: TaskRecord): boolean {
  return t.origin?.provider === AGENTD_TASK_PROVIDER_ID
    || AGENTD_TASK_PROVIDER_ID in (t.links ?? {});
}

/** 人工任务判定：排除 agent 标题/描述标记与工人小组独占，避免把机器任务当人工滞留 */
function isHumanDispatchedTask(t: TaskRecord): boolean {
  if ((t.assigned?.provider ?? "").startsWith("worker-team/")) return false;
  if (/【agent】/.test(t.title ?? "")) return false;
  const marked = (t.description ?? "").match(/执行[者人][:：]\s*([^\s，,。；;】）)\]]+)/)?.[1];
  return !/^(agent|agentd)$/i.test(marked ?? "");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function memberOf(members: IdentityMember[], memberId: string | undefined): IdentityMember | undefined {
  if (!memberId) return undefined;
  return members.find((m) => m.member_id === memberId);
}

export function buildStaleTaskNotice(
  t: TaskRecord,
  member: IdentityMember | undefined,
  nowMs: number,
  thresholdMs = STALE_TASK_THRESHOLD_MS,
): string {
  const idleHours = Math.floor(Math.max(0, nowMs - t.updatedAt) / 3_600_000);
  const owner = member
    ? (member.feishu_open_ids?.[0]
      ? `<at user_id="${member.feishu_open_ids[0]}">${member.name}</at>`
      : `负责人：${member.name}`)
    : t.assignee_member_id
      ? `负责人：${t.assignee_member_id}（飞书未绑定）`
      : "负责人：未登记";
  const title = (t.title ?? t.uid).replace(/^【[^】]*】\s*/, "").slice(0, 80);
  return [
    `⏰ 任务滞留提醒（已 ${idleHours || Math.ceil(thresholdMs / 3_600_000)} 小时无进展）`,
    owner,
    `「${title}」`,
    `最后变化：${formatTime(t.updatedAt)} ｜ 当前：D 执行中`,
    "请回复进展或调整分组。",
  ].join("\n");
}

/**
 * 每拍执行。首拍仅建基线；之后对新增/推进后再次停滞/负责人变更的任务提醒一次。
 */
export async function remindStaleTasks(
  registry: { list: (q: { status: UnifiedStatus[] }) => TaskRecord[] },
  options: StaleTaskReminderOptions,
): Promise<StaleTaskReminderResult> {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const thresholdMs = options.thresholdMs ?? STALE_TASK_THRESHOLD_MS;
  const stateFile = options.stateFile
    ?? process.env["STALE_TASK_REMINDER_STATE_FILE"]
    ?? DEFAULT_STATE_FILE;
  const members = options.members ?? identityMembers(getIdentityRegistry());
  const state = loadState(stateFile);
  const dispatched = registry.list({ status: ["dispatched"] });
  const stale = dispatched.filter(
    (t) => isHumanDispatchedTask(t) && !hasAgentdHandle(t) && nowMs - t.updatedAt > thresholdMs,
  );
  const result: StaleTaskReminderResult = { baselined: 0, sent: 0, failed: 0 };

  if (!state.initializedAt) {
    state.initializedAt = nowMs;
    for (const t of stale) {
      state.tasks[t.uid] = {
        staleNotifiedAt: nowMs,
        notifiedForUpdatedAt: t.updatedAt,
        assignee: t.assignee_member_id ?? "",
      };
      result.baselined++;
    }
    saveState(stateFile, state);
    return result;
  }

  let dirty = false;
  for (const t of stale) {
    const ownerKey = t.assignee_member_id ?? "";
    const previous = state.tasks[t.uid];
    const progressed = Boolean(previous && t.updatedAt > previous.notifiedForUpdatedAt);
    const ownerChanged = Boolean(previous && previous.assignee !== ownerKey);
    if (previous && !progressed && !ownerChanged) continue;

    const text = buildStaleTaskNotice(t, memberOf(members, t.assignee_member_id), nowMs, thresholdMs);
    const sent = await options.sendGroup(text).catch(() => false);
    if (!sent) {
      result.failed++;
      continue;
    }
    state.tasks[t.uid] = {
      staleNotifiedAt: nowMs,
      notifiedForUpdatedAt: t.updatedAt,
      assignee: ownerKey,
    };
    result.sent++;
    dirty = true;
  }
  if (dirty) saveState(stateFile, state);
  return result;
}
