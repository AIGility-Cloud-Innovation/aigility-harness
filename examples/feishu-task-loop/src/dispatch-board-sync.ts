/**
 * dispatch-board-sync — 派发中任务的看板正向同步（对齐器每拍执行）
 *
 * 背景（2026-10-24 用户拍板「立刻进D」）：此前看板同步是「以板为准」单向
 * 对齐（板面挪动 → 台账跟随），反过来「台账状态变了 → 主动挪卡片」缺失。
 * 结果：工人的活照干（PR 也照出），但卡片永远停在 P，用户每天看到 P。
 *
 * 动作：台账 status=dispatched|running 且 note 带 [worker-team/<member>] 标记
 * → 飞书镜像卡片挪「D 执行中」+ board-projection 记 D。
 *
 * 幂等：投影已是 D 跳过（飞书侧被人工挪回也不反复抢——以投影为准）。
 * 一致性：也要把台账回退（非 dispatched/running）但投影为 D 的卡挪回 P，
 * 否则工人超时/失败后卡片会永远挂在 D（今天 t102051 僵尸卡正是这个形态）。
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
    /* 投影写失败不阻塞主流程（最坏：下拍多挪一次，幂等） */
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

/** 段位名首字母键：P/D/C/A/挂 */
function sectionKeyOf(name: string | undefined): string | undefined {
  const c = (name ?? "").trim()[0]?.toUpperCase();
  return c && "PDCA".includes(c) || c === "挂" ? c : undefined;
}

/** 把卡片挪到目标段位（找不到段位则建）。返回 moved|already|false */
async function moveTaskToSection(
  call: Call,
  taskGuid: string,
  targetName: string,
): Promise<"moved" | "already" | false> {
  const targetKey = sectionKeyOf(targetName);
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
    if (!tasks.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue; // 不在该清单
    const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    // 定位卡片当前所在段位
    let inTarget = false;
    for (const sec of secs) {
      if (!sec.guid) continue;
      const items = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
        path: `/open-apis/task/v2/sections/${sec.guid}/tasks`,
        query: { page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      if (!items.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue;
      inTarget = sectionKeyOf(sec.name) === targetKey;
      break;
    }
    if (inTarget) return "already";
    // 找目标段位
    let targetGuid = secs.find((s) => sectionKeyOf(s.name) === targetKey)?.guid;
    if (!targetGuid) {
      const cr = await call({
        method: "POST",
        path: "/open-apis/task/v2/sections",
        query: { user_id_type: "open_id" },
        identity: "user",
        body: { name: targetName, resource_type: "tasklist", resource_id: l.guid },
      });
      const v = cr.value as { code?: number; data?: { section?: { guid?: string } } } | undefined;
      if (!cr.ok || (v?.code ?? -1) !== 0) return false;
      targetGuid = v?.data?.section?.guid;
      if (!targetGuid) {
        const after = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
          path: "/open-apis/task/v2/sections",
          query: { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" },
          identity: "user",
        }))?.items ?? [];
        targetGuid = after.find((s) => sectionKeyOf(s.name) === targetKey)?.guid;
      }
      if (!targetGuid) return false;
    }
    const mv = await call({
      method: "POST",
      path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { tasklist_guid: l.guid, section_guid: targetGuid },
    });
    return mv.ok && ((mv.value as { code?: number })?.code ?? -1) === 0 ? "moved" : false;
  }
  return false;
}

/** 每拍执行。返回变更摘要（供日志；空数组=无事发生）。 */
export async function syncDispatchedTasks(
  registry: TaskRegistry,
  feishuCall: Call,
): Promise<string[]> {
  const projection = loadProjection();
  const changes: string[] = [];
  let dirty = false;

  const guidOf = (t: { links?: Record<string, { guid?: string }>; origin?: { provider?: string; guid?: string } }): string | undefined =>
    t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);

  // ① 台账在跑 → 卡片进 D（用户拍板「立刻进D」：派发即挪，不等验收）
  for (const t of registry.list({ status: ["dispatched", "running"] })) {
    const guid = guidOf(t);
    if (!guid) continue;
    if (!/\[worker-team\/[a-z]+\]/.test(t.note ?? "")) continue; // 只处理工人任务
    if (projection[t.uid] === "D") continue; // 幂等
    const r = await moveTaskToSection(feishuCall, guid, SECTION_NAMES.doing);
    if (r === false) continue; // 失败留待下拍重试
    projection[t.uid] = "D";
    dirty = true;
    changes.push(`挪D:${t.title.slice(0, 22)}`);
  }

  // ② 台账已退回（失败/挂起/待派）但投影仍是 D → 卡片挪回 P，防僵尸卡滞 D
  for (const t of registry.list({ status: ["planned", "ready", "failed", "blocked", "suspended", "needs-input"] })) {
    if (projection[t.uid] !== "D") continue;
    const guid = guidOf(t);
    if (!guid) continue;
    const r = await moveTaskToSection(feishuCall, guid, SECTION_NAMES.plan);
    if (r === false) continue;
    projection[t.uid] = "P";
    dirty = true;
    changes.push(`退回P:${t.title.slice(0, 22)}(${t.status})`);
  }

  if (dirty) saveProjection(projection);
  return changes;
}
