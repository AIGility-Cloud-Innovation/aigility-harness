/**
 * board-sync — 飞书看板反向对齐（每拍，完成核对之后）
 *
 * 人在看板上手动挪组是最高优先级的人工信号：台账状态经合法转移路径跟随。
 * 系统自己的前向投影（放行时挪 D、回建时进 C）会记录为「预期截面」——
 * 实际截面 == 预期截面时视为一致；实际偏离预期才判定为人工操作。
 * 首次见到某任务只记基线不动作（避免上线瞬间把存量全部误判为人工变更）。
 *
 * 截面 → 状态：P 计划中→planned · D 执行中→dispatched · C 待测试→review ·
 * A 待修复→failed · 未分组→planned（收编约定）。自定义分组（非 PDCA）不判。
 * 台账跟随走合法转移路径（BFS 多跳，如 planned→ready→dispatched）；
 * 无合法路径时记冲突并采纳实际截面（避免反复报同一冲突）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_STATUS_TRANSITIONS } from "@aigility-harness/core";
import type { UnifiedStatus } from "@aigility-harness/core";
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROJECTION_FILE = join(ROOT, "config", "board-projection.local.json");

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

function sectionKeyOf(name: string | undefined): string | undefined {
  const n = (name ?? "").trim();
  if (n.startsWith("挂")) return "挂"; // 自定义「挂起」组（2026-10-22：分组即状态）
  const c = n[0]?.toUpperCase();
  return ["P", "D", "C", "A"].includes(c ?? "") ? c : undefined;
}

function loadProjection(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PROJECTION_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveProjection(p: Record<string, string>): void {
  writeFileSync(PROJECTION_FILE, JSON.stringify(p, null, 2));
}

/** 提醒/查询用：某任务当前预期截面（P/D/C/A），无记录返回 undefined */
export function getProjectedSection(uid: string): string | undefined {
  return loadProjection()[uid];
}

/** BFS 求合法转移路径（含中间跳）；不可达返回 undefined */
export function transitionPath(from: string, to: string): string[] | undefined {
  if (from === to) return [];
  const queue: Array<{ s: string; path: string[] }> = [{ s: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift()!;
      for (const next of TASK_STATUS_TRANSITIONS[cur.s as UnifiedStatus] ?? []) {
      if (next === to) return [...cur.path, next];
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ s: next, path: [...cur.path, next] });
      }
    }
  }
  return undefined;
}

async function callData<T>(call: Call, req: Record<string, unknown>): Promise<T | undefined> {
  const r = await call(req);
  if (!r.ok) return undefined;
  const v = r.value as { code?: number; status?: number; data?: unknown } | undefined;
  if (v?.code !== undefined && v.code !== 0) return undefined;
  if (v?.status !== undefined && (v.status < 200 || v.status >= 300)) return undefined;
  return v?.data as T;
}

/** 每拍反向对齐。返回变更说明列表（供日志）。 */
export async function syncBoardAlignment(
  registry: TaskRegistry,
  feishuCall: Call,
): Promise<string[]> {
  const changes: string[] = [];
  const projection = loadProjection();
  let dirty = false;

  // ① 扫描看板实际截面：逐清单 → 逐 PDCA 分组 → 组内任务；未分组 → P（收编约定）
  const actualByGuid = new Map<string, string>();
  const lists = (await callData<{ items?: Array<{ guid?: string }> }>(feishuCall, {
    path: "/open-apis/task/v2/tasklists",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }))?.items ?? [];
  for (const l of lists) {
    if (!l.guid) continue;
    const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(feishuCall, {
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    const sectioned = new Set<string>();
    for (const sec of secs) {
      const key = sectionKeyOf(sec.name);
      if (!sec.guid || !key) continue; // 自定义分组不参与 PDCA 判定
      const items = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(feishuCall, {
        path: `/open-apis/task/v2/sections/${sec.guid}/tasks`,
        query: { completed: false, page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      for (const t of items) {
        const g = t.guid ?? t.task_id;
        if (!g) continue;
        actualByGuid.set(g, key);
        sectioned.add(g);
      }
    }
    const all = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(feishuCall, {
      path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`,
      query: { completed: false, page_size: 100, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    for (const t of all) {
      const g = t.guid ?? t.task_id;
      if (g && !sectioned.has(g)) actualByGuid.set(g, "P"); // 未分组 = P（收编约定）
    }
  }

  // ② 逐任务比对：实际 vs 预期 → 人工挪动则台账经合法路径跟随
  for (const t of registry.list({ status: ["planned", "ready", "dispatched", "running", "review", "failed", "blocked", "suspended"] })) {
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    if (!guid) continue;
    const actual = actualByGuid.get(guid);
    if (!actual) continue; // 不在未完成清单（已完成/无镜像）→ 不判
    const prev = projection[t.uid];
    if (prev === actual) continue; // 一致
    if (prev === undefined) {
      projection[t.uid] = actual; // 首见：记基线，不动作
      dirty = true;
      continue;
    }
    const target = ({ P: "planned", D: "dispatched", C: "review", A: "failed" } as Record<string, UnifiedStatus | undefined>)[actual];
    const path = target ? transitionPath(t.status, target) : undefined;
    if (!path) {
      projection[t.uid] = actual;
      dirty = true;
      changes.push(`「${t.title.slice(0, 24)}」看板 ${prev}→${actual}：无合法转移路径，已采纳看板截面（台账保留 ${t.status}）`);
      continue;
    }
    for (const step of path) {
      const r = registry.transition(t.uid, step as UnifiedStatus);
      if (!r.ok) break;
    }
    projection[t.uid] = actual;
    dirty = true;
    changes.push(`「${t.title.slice(0, 24)}」人工挪动 ${prev}→${actual}，台账已跟随`);
  }

  if (dirty) saveProjection(projection);
  return changes;
}
