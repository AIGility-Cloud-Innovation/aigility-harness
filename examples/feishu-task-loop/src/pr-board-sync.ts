/**
 * pr-board-sync — agent 任务卡片的 PDCA 正向投影（对齐器每拍执行）
 *
 * 台账是 agent 任务的真相源，飞书卡片只是镜像：
 *   planned/ready       → P 计划中
 *   dispatched/running  → D 执行中
 *   review（PR 已建）    → C 待测试
 *   failed              → A 待修复
 *
 * 每次系统挪卡后同步写 board-projection.local.json 的 projection[uid]，
 * 让 board-sync 的「预期截面」机制识别为机器动作，不反向抢态。
 *
 * 失败播报：台账转 failed 时在群里播一次「标题 + note 失败原因 + 产出保留位置」，
 * 失败标记随投影状态文件持久化；任务重新放行后再次失败可再次播报。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SECTION_NAMES,
  slugifyBranch,
} from "@aigility-harness/layer-orchestration";
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";
import type { TaskRecord, UnifiedStatus } from "@aigility-harness/core";

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

type SectionKey = "P" | "D" | "C" | "A";

const DEFAULT_PROJECTION_FILE = join(
  import.meta.dirname ?? ".",
  "..", "..", "..", "config", "board-projection.local.json",
);
const DEFAULT_STATE_FILE = join(
  import.meta.dirname ?? ".",
  "..", "..", "..", "config", "agent-board-sync.local.json",
);

interface AgentBoardState {
  /** uid → 已播报的失败版本（台账 updatedAt）；同一失败只播一次 */
  failureNotified: Record<string, number>;
}

export interface AgentBoardSyncOptions {
  /** 群播报（失败任务）；未注入时只挪卡不播报 */
  sendGroup?: (text: string) => Promise<boolean>;
  /** 测试注入：投影文件路径 */
  projectionFile?: string;
  /** 测试注入：失败播报状态文件路径 */
  stateFile?: string;
  /** 当前看板截面（board-sync 已扫描）；「挂」表示人工挂起，正向投影不得拉回 P */
  projectedSection?: (uid: string) => string | undefined;
}

function loadJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function saveJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    /* 状态写失败不阻塞交付投影；最坏情况下拍重复幂等操作 */
  }
}

function loadProjection(file: string): Record<string, string> {
  return loadJson<Record<string, string>>(file) ?? {};
}

function saveProjection(file: string, p: Record<string, string>): void {
  saveJson(file, p);
}

function loadState(file: string): AgentBoardState {
  return loadJson<AgentBoardState>(file) ?? { failureNotified: {} };
}

function callData<T>(call: Call, req: Record<string, unknown>): Promise<T | undefined> {
  return (async () => {
    const r = await call(req);
    if (!r.ok) return undefined;
    const v = r.value as { code?: number; status?: number; data?: unknown } | undefined;
    if (v?.code !== undefined && v.code !== 0) return undefined;
    if (v?.status !== undefined && (v.status < 200 || v.status >= 300)) return undefined;
    return v?.data as T;
  })();
}

function sectionKeyOf(name: string | undefined): SectionKey | undefined {
  const key = (name ?? "").trim()[0]?.toUpperCase();
  return key === "P" || key === "D" || key === "C" || key === "A" ? key : undefined;
}

/** 台账状态 → 目标 PDCA 截面（done/cancelled 等终态不投影） */
export function sectionKeyForStatus(status: UnifiedStatus): SectionKey | undefined {
  switch (status) {
    case "planned":
    case "ready":
      return "P";
    case "dispatched":
    case "running":
      return "D";
    case "review":
      return "C";
    case "failed":
      return "A";
    default:
      return undefined;
  }
}

/** agent 任务识别：人工负责人优先；否则标题【agent】、描述 agent 执行者、工人句柄任一命中 */
export function isAgentTaskRecord(t: Pick<TaskRecord, "title" | "description" | "assignee_member_id" | "assigned" | "note">): boolean {
  if (t.assignee_member_id) return false;
  if (/【agent】/.test(t.title ?? "")) return true;
  const marked = (t.description ?? "").match(/执行[者人][:：]\s*([^\s，,。；;】）)\]]+)/)?.[1];
  if (/^(agent|agentd)$/i.test(marked ?? "")) return true;
  if ((t.assigned?.provider ?? "").startsWith("worker-team/")) return true;
  return /\[worker-team\/[a-z]+\]/.test(t.note ?? "");
}

/** 失败原因取 note（去掉工人标记），其次 attempts.lastError */
export function failureReasonOf(t: Pick<TaskRecord, "note" | "attempts">): string {
  const fromNote = (t.note ?? "").replace(/^\[worker-team\/[a-z]+\]\s*/i, "").trim();
  const reason = fromNote || (t.attempts?.lastError ?? "").trim();
  return (reason || "未记录失败原因").replace(/\s+/g, " ").slice(0, 500);
}

/** 失败播报：标题 + 失败原因 + 产出保留位置（worktree/分支/PR 链接） */
export function buildFailureNotice(
  t: TaskRecord,
): string {
  const reason = failureReasonOf(t);
  const prUrl = (t.note ?? "").match(/https:\/\/git\.aigility\.cloud\/[^\s（)）]+\/pulls\/\d+/)?.[0];
  // worker-team claim 的 handle 就是任务专属 worktree 路径；失败后 assigned 保留，
  // 因此这里能直接告诉接管人现场在哪。非文件句柄（如 agentd task id）不冒充路径。
  const handle = t.assigned?.handle;
  const worktree = handle && (handle.startsWith("/") || handle.startsWith(".")) ? handle : undefined;
  const branch = `agent/${slugifyBranch(t.title ?? t.uid)}-${t.uid.slice(-6)}`;
  const keep = [
    worktree ? `worktree ${worktree}` : undefined,
    `分支 ${branch}`,
    prUrl ? `PR ${prUrl}` : undefined,
  ].filter(Boolean);
  return [
    "❌ agent 任务失败",
    `「${(t.title ?? t.uid).slice(0, 80)}」`,
    `原因：${reason}`,
    `产出保留：${keep.join(" ｜ ")}`,
    `台账：${t.uid}`,
  ].join("\n");
}

async function findSection(call: Call, listGuid: string, key: SectionKey): Promise<string | undefined> {
  const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
    path: "/open-apis/task/v2/sections",
    query: { resource_type: "tasklist", resource_id: listGuid, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }))?.items ?? [];
  return secs.find((s) => sectionKeyOf(s.name) === key)?.guid;
}

async function ensureSection(call: Call, listGuid: string, key: SectionKey): Promise<string | undefined> {
  const existing = await findSection(call, listGuid, key);
  if (existing) return existing;
  const name = key === "P" ? SECTION_NAMES.plan
    : key === "D" ? SECTION_NAMES.doing
    : key === "C" ? SECTION_NAMES.check
    : SECTION_NAMES.fix;
  const cr = await call({
    method: "POST",
    path: "/open-apis/task/v2/sections",
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { name, resource_type: "tasklist", resource_id: listGuid },
  });
  const v = cr.value as { code?: number } | undefined;
  if (!cr.ok || (v?.code ?? -1) !== 0) return undefined;
  return findSection(call, listGuid, key);
}

async function moveViaAddTasklist(call: Call, taskGuid: string, listGuid: string, sectionGuid: string): Promise<boolean> {
  const mv = await call({
    method: "POST",
    path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { tasklist_guid: listGuid, section_guid: sectionGuid },
  });
  return mv.ok && ((mv.value as { code?: number })?.code ?? -1) === 0;
}

/** 找任务所在清单与分组，挪到目标 PDCA 分组；已在目标分组则幂等成功 */
async function moveTaskToSection(
  call: Call,
  taskGuid: string,
  target: SectionKey,
): Promise<"moved" | "already" | false> {
  const lists = (await callData<{ items?: Array<{ name?: string; guid?: string }> }>(call, {
    path: "/open-apis/task/v2/tasklists",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }))?.items ?? [];
  for (const l of lists) {
    if (!l.guid) continue;
    const tasks = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
      path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`,
      query: { page_size: 100, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    if (!tasks.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue;
    const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    for (const sec of secs) {
      if (!sec.guid) continue;
      const items = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
        path: `/open-apis/task/v2/sections/${sec.guid}/tasks`,
        query: { page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      if (!items.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue;
      if (sectionKeyOf(sec.name) === target) return "already";
      break;
    }
    const targetGuid = await ensureSection(call, l.guid, target);
    if (!targetGuid) return false;
    return (await moveViaAddTasklist(call, taskGuid, l.guid, targetGuid)) ? "moved" : false;
  }
  return false;
}

function guidOf(t: TaskRecord): string | undefined {
  return t.links?.["feishu-task"]?.guid
    ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
}

/** note 里的 PR 链接兜底补写进飞书描述（2026-10-23 用户需求；幂等） */
async function backfillPrLink(call: Call, guid: string, note: string | undefined): Promise<string | undefined> {
  const prUrl = (note ?? "").match(/https:\/\/git\.aigility\.cloud\/[^\s（)）]+\/pulls\/\d+/)?.[0];
  if (!prUrl) return undefined;
  const cur = await callData<{ description?: string }>(call, {
    method: "GET",
    path: `/open-apis/task/v2/tasks/${guid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  if (!cur || (cur.description ?? "").includes(prUrl)) return undefined;
  const next = `${(cur.description ?? "").trim()}${cur.description?.trim() ? "\n" : ""}🔗 交付 PR：${prUrl}`;
  await call({
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${guid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { update_fields: ["description"], task: { description: next } },
  }).catch(() => undefined);
  return prUrl.split("/pulls/")[1];
}

/**
 * 每拍执行。返回动作说明列表（供日志；空数组=无事发生）。
 * 兼容旧名 syncPrDeliveredTasks：识别范围已从「工人小组 review」放宽到所有 agent 任务。
 */
export async function syncPrDeliveredTasks(
  registry: TaskRegistry,
  feishuCall: Call,
  options: AgentBoardSyncOptions = {},
): Promise<string[]> {
  const projectionFile = options.projectionFile ?? DEFAULT_PROJECTION_FILE;
  const stateFile = options.stateFile ?? process.env["AGENT_BOARD_SYNC_STATE_FILE"] ?? DEFAULT_STATE_FILE;
  const projection = loadProjection(projectionFile);
  const state = loadState(stateFile);
  const projectedSection = options.projectedSection ?? (() => undefined);
  const actions: string[] = [];
  let projectionDirty = false;
  let stateDirty = false;

  const tasks = registry.list({
    status: ["planned", "ready", "dispatched", "running", "review", "failed"],
  });
  for (const t of tasks) {
    if (!isAgentTaskRecord(t)) continue;
    if (t.status !== "failed" && state.failureNotified[t.uid] !== undefined) {
      delete state.failureNotified[t.uid];
      stateDirty = true;
    }

    const target = sectionKeyForStatus(t.status);
    const guid = guidOf(t);
    const parked = projectedSection(t.uid) === "挂";
    if (target && !parked && guid && projection[t.uid] !== target) {
      const moved = await moveTaskToSection(feishuCall, guid, target);
      if (moved !== false) {
        projection[t.uid] = target;
        projectionDirty = true;
        if (moved === "moved") actions.push(`挪${target}:${t.title.slice(0, 24)}`);
      }
    }
    if (guid) {
      const prNo = await backfillPrLink(feishuCall, guid, t.note);
      if (prNo) actions.push(`补PR链:${t.title.slice(0, 20)}←${prNo}`);
    }

    if (t.status !== "failed" || state.failureNotified[t.uid] === t.updatedAt) continue;
    if (!options.sendGroup) continue;
    const text = buildFailureNotice(t);
    const sent = await options.sendGroup(text).catch(() => false);
    if (!sent) continue;
    state.failureNotified[t.uid] = t.updatedAt;
    stateDirty = true;
    actions.push(`失败播报:${t.title.slice(0, 24)}`);
  }
  if (projectionDirty) saveProjection(projectionFile, projection);
  if (stateDirty) saveJson(stateFile, state);
  return actions;
}
