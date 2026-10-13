/**
 * pr-board-sync — PR 交付型任务的看板正向同步（对齐器每拍执行）
 *
 * 背景（2026-10-13 负责人拍板）：agent 任务「始于台账、终结于 PR」——PR 建成
 * 台账即转 review（待验收），飞书卡片应同步挪「C 待测试」。此前的完成核对只认
 * 「工单 closed」信号，PR 交付型（免工单链）卡片无人挪、全程滞留 P。
 *
 * 识别特征：台账 status=review 且 note 含 [worker-team/<member>]（工人小组交付
 * 产物，note 同时携 PR 链接）。人工任务的 review 不带此标记，不受影响。
 *
 * 动作：飞书镜像卡片挪「C 待测试」（SECTION_NAMES.check，幂等防重挪）+
 * board-projection 投影记 C（防止反向对齐把正向动作误判为人工挪动）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_NAMES } from "@aigility-harness/layer-orchestration";
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

const PROJECTION_FILE = join(
  import.meta.dirname ?? ".",
  "..", "..", "..", "config", "board-projection.local.json",
);

function loadProjection(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PROJECTION_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveProjection(p: Record<string, string>): void {
  try {
    writeFileSync(PROJECTION_FILE, JSON.stringify(p, null, 2));
  } catch {
    /* 投影写失败不阻塞主流程（最坏情况：下拍多挪一次，幂等） */
  }
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

/** 飞书清单里「C 待测试」分组的 guid（找不到返回 undefined，由调用方决定是否建） */
async function findCheckSection(call: Call, listGuid: string): Promise<string | undefined> {
  const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
    path: "/open-apis/task/v2/sections",
    query: { resource_type: "tasklist", resource_id: listGuid, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }))?.items ?? [];
  return secs.find((s) => (s.name ?? "").trim() === SECTION_NAMES.check)?.guid;
}

/** 挪卡片：找到所在清单 → 确认所在分组 → 已在 C 则幂等跳过 → add_tasklist 挪组 */
async function moveTaskToCheck(call: Call, taskGuid: string): Promise<"moved" | "already" | false> {
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
    const cKey = SECTION_NAMES.check.trim()[0]?.toUpperCase() ?? "C";
    const cur = secs.find((s) => {
      const g = s.guid;
      if (!g) return false;
      // 所在分组是否已是 C：按名字匹配 C 组
      return (s.name ?? "").trim()[0]?.toUpperCase() === cKey;
    });
    // 任务在哪个分组：逐分组查（清单内分组数少，逐个查可接受）
    for (const sec of secs) {
      if (!sec.guid) continue;
      const items = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
        path: `/open-apis/task/v2/sections/${sec.guid}/tasks`,
        query: { page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      if (!items.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue;
      const isCheck = (sec.name ?? "").trim()[0]?.toUpperCase() === cKey;
      if (isCheck) return "already";
      break; // 找到所在分组且非 C → 需要挪
    }
    if (!cur) {
      const cr = await call({
        method: "POST",
        path: "/open-apis/task/v2/sections",
        query: { user_id_type: "open_id" },
        identity: "user",
        body: { name: SECTION_NAMES.check, resource_type: "tasklist", resource_id: l.guid },
      });
      const v = cr.value as { code?: number; data?: { section?: { guid?: string } } } | undefined;
      if (!cr.ok || (v?.code ?? -1) !== 0) return false;
      // 建组后重新解析 guid（响应壳与列表一致）
      const created = await findCheckSection(call, l.guid);
      if (!created) return false;
      return (await moveViaAddTasklist(call, taskGuid, l.guid, created)) ? "moved" : false;
    }
    return (await moveViaAddTasklist(call, taskGuid, l.guid, cur.guid!)) ? "moved" : false;
  }
  return false;
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

/** 每拍执行。返回已挪卡的任务标题列表（供日志；空数组=无事发生）。 */
export async function syncPrDeliveredTasks(
  registry: TaskRegistry,
  feishuCall: Call,
): Promise<string[]> {
  // PR 交付型 review 任务：工人小组产物（note 带成员标记 + PR 链接）
  const targets = registry
    .list({ status: ["review"] })
    .filter((t) => /\[worker-team\/[a-z]+\]/.test(t.note ?? ""));
  if (targets.length === 0) return [];

  const projection = loadProjection();
  const moved: string[] = [];
  let dirty = false;
  for (const t of targets) {
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    if (!guid) continue;
    // 幂等：投影已是 C 视为已挪过（飞书侧被人工挪回也不反复抢——以投影为准）
    if (projection[t.uid] === "C") continue;
    const r = await moveTaskToCheck(feishuCall, guid);
    if (r === false) continue; // 失败留待下拍重试
    projection[t.uid] = "C";
    dirty = true;
    moved.push(t.title.slice(0, 24));
  }
  if (dirty) saveProjection(projection);
  return moved;
}
