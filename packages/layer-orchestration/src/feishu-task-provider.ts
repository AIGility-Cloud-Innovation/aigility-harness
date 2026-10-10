/**
 * L4 编排层: feishu-task-provider — 收集 provider（飞书任务清单 → 登记表候选）
 *
 * 把「org 清单扫描 → 分组任务/未分组任务」的读取域从 task-issue-sync /
 * project-briefing 中抽出，落进 core 的 TaskProvider 契约（capabilities:
 * collect=true, execute=false——飞书侧只做规划看板，实施派发走 agentd/工单）。
 *
 * 契约约定：
 *   - collect 吐 CollectTaskInput，uid 由 TaskRegistry 发号、按 origin 去重，
 *     故本 provider 无状态可重复扫（与 10min 扫描节拍兼容）。
 *   - mapStatus 的"原生状态"词汇 = 清单自定义分组名（P/D/C/A，SECTION_NAMES）。
 *   - feishu 调用经 call 注入（生产= ctx.call(feishuApiRef)，测试=假桩），
 *     与 briefing/task-issue-sync 的 ctx.call({id:"@action/feishu-api"}) 同形。
 *
 * 归属解析：标题前缀 [org/repo] / [org/repo#N] → projectRef（复用
 * task-issue-sync 的既定约定）；解析不出 projectRef 留空，归仓交给上游。
 */
import type { CollectTaskInput, TaskCursor, TaskProvider, UnifiedStatus } from "@aigility-harness/core";
import { SECTION_NAMES, repoFromPlannedSummary } from "./task-issue-sync.js";

export const FEISHU_TASK_PROVIDER_ID = "feishu-task";

/** 飞书自定义分组名 → 统一状态投影（与契约文件头的投影表一致） */
export const SECTION_TO_STATUS: Record<string, UnifiedStatus> = {
  [SECTION_NAMES.plan]: "planned",
  [SECTION_NAMES.doing]: "dispatched",
  [SECTION_NAMES.check]: "review",
  [SECTION_NAMES.fix]: "failed",
};

/** feishu-api 透传结果的最小形状（ctx.call 的 Result<FeishuApiResponse>） */
export interface FeishuApiResultLike {
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown };
  error?: string;
}

/** 注入的 feishu 调用（生产：ctx.call(feishuApiRef)；测试：假桩） */
export type FeishuCall = (req: Record<string, unknown>) => Promise<FeishuApiResultLike>;

export interface FeishuCollectOptions {
  /** 只收集这些清单（org 清单约定按名单过滤）；空/缺省 = 全部可见清单 */
  tasklistNames?: string[];
}

// ── 飞书任务 v2 读取域（全部 user 身份，与 task-issue-sync 契约一致） ──

interface FeishuTaskItem {
  guid?: string;
  task_id?: string;
  summary?: string;
  url?: string;
  description?: string;
  completed_at?: string | number;
}

interface FeishuListRef {
  name?: string;
  guid?: string;
}

async function callData<T>(call: FeishuCall, req: Record<string, unknown>): Promise<T | undefined> {
  const r = await call(req);
  if (!r.ok || (r.value?.code ?? -1) !== 0) return undefined;
  return r.value?.data as T;
}

async function listAllTasklists(call: FeishuCall): Promise<FeishuListRef[]> {
  const out: FeishuListRef[] = [];
  let token: string | undefined;
  do {
    const d = await callData<{ items?: FeishuListRef[]; page_token?: string }>(call, {
      path: "/open-apis/task/v2/tasklists",
      query: { page_size: 50, user_id_type: "open_id", ...(token ? { page_token: token } : {}) },
      identity: "user",
    });
    if (!d) return out;
    out.push(...(d.items ?? []));
    token = d.page_token;
  } while (token);
  return out;
}

async function listSections(call: FeishuCall, tasklistGuid: string): Promise<FeishuListRef[]> {
  const d = await callData<{ items?: FeishuListRef[] }>(call, {
    path: "/open-apis/task/v2/sections",
    query: { resource_type: "tasklist", resource_id: tasklistGuid, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  return d?.items ?? [];
}

async function listSectionTasks(call: FeishuCall, sectionGuid: string): Promise<FeishuTaskItem[]> {
  // 不带 completed 参数（实测当前租户带该参数恒返回空列表），代码内按 completed_at 过滤
  const d = await callData<{ items?: FeishuTaskItem[]; page_token?: string }>(call, {
    path: `/open-apis/task/v2/sections/${sectionGuid}/tasks`,
    query: { page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  return (d?.items ?? []).filter((t) => !t.completed_at || Number(t.completed_at) === 0);
}

async function listTasklistTasks(call: FeishuCall, tasklistGuid: string): Promise<FeishuTaskItem[]> {
  const out: FeishuTaskItem[] = [];
  let token: string | undefined;
  do {
    // 同上：不带 completed 参数，代码内过滤
    const d = await callData<{ items?: FeishuTaskItem[]; page_token?: string }>(call, {
      path: `/open-apis/task/v2/tasklists/${tasklistGuid}/tasks`,
      query: { page_size: 100, user_id_type: "open_id", ...(token ? { page_token: token } : {}) },
      identity: "user",
    });
    if (!d) break;
    out.push(...(d.items ?? []));
    token = d.page_token;
  } while (token);
  return out.filter((t) => !t.completed_at || Number(t.completed_at) === 0);
}

// ── 归属解析 ─────────────────────────────────────────────────────

/** 标题 → projectRef：[org/repo] 前缀优先，退回 [org/repo#N] 双建标题 */
export function projectRefFromSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return repoFromPlannedSummary(summary) ?? summary.match(/\[([^\]#/]+)\/([^\]#]+)#\d+\]/)?.slice(1, 3).join("/");
}

function toCandidate(t: FeishuTaskItem, sectionName: string | undefined): CollectTaskInput | undefined {
  const guid = t.guid ?? t.task_id;
  if (!guid) return undefined;
  const summary = t.summary ?? "(无标题)";
  return {
    title: summary,
    ...(t.description ? { description: t.description } : {}),
    status: (sectionName && SECTION_TO_STATUS[sectionName]) || "planned",
    origin: { provider: FEISHU_TASK_PROVIDER_ID, guid, ...(t.url ? { url: t.url } : {}) },
    projectRef: projectRefFromSummary(summary),
  };
}

// ── 扫描（全量单遍；游标 = 上轮已完成的最后一个清单 guid，续传跳过其前） ──

export async function* sweepFeishuTasks(
  call: FeishuCall,
  opts: FeishuCollectOptions,
  cursor?: TaskCursor,
): AsyncGenerator<CollectTaskInput> {
  const lists = await listAllTasklists(call);
  const wanted = opts.tasklistNames?.length ? lists.filter((l) => opts.tasklistNames!.includes(l.name ?? "")) : lists;
  const resumeAfter = cursor?.value;
  let skipping = Boolean(resumeAfter);

  for (const list of wanted) {
    if (!list.guid) continue;
    if (skipping) {
      if (list.guid === resumeAfter) skipping = false; // 从断点清单的下一个开始
      continue;
    }
    const sectioned = new Set<string>();
    for (const sec of await listSections(call, list.guid)) {
      if (!sec.guid) continue;
      for (const t of await listSectionTasks(call, sec.guid)) {
        sectioned.add(t.guid ?? t.task_id ?? "");
        const c = toCandidate(t, sec.name);
        if (c) yield c;
      }
    }
    // 未分组裸任务（成员手工建）→ planned，进入统一闸门（对齐 adoptUnsectionedTasks 约定）
    for (const t of await listTasklistTasks(call, list.guid)) {
      if (sectioned.has(t.guid ?? t.task_id ?? "")) continue;
      const c = toCandidate(t, undefined);
      if (c) yield c;
    }
  }
}

/** 一次性收集为数组（测试/批处理便捷入口） */
export async function collectFeishuTasks(
  call: FeishuCall,
  opts: FeishuCollectOptions = {},
  cursor?: TaskCursor,
): Promise<CollectTaskInput[]> {
  const out: CollectTaskInput[] = [];
  for await (const c of sweepFeishuTasks(call, opts, cursor)) out.push(c);
  return out;
}

/** 契约实现（未实现 execute/sync：飞书侧不做实施，状态回写由投影层负责） */
export function createFeishuTaskProvider(call: FeishuCall, opts: FeishuCollectOptions = {}): TaskProvider {
  return {
    id: FEISHU_TASK_PROVIDER_ID,
    capabilities: { collect: true, execute: false },
    mapStatus: (native: string) => SECTION_TO_STATUS[native],
    collect: (cursor?: TaskCursor) => sweepFeishuTasks(call, opts, cursor),
  };
}
