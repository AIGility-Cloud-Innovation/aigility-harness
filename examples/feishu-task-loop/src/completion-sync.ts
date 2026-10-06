/**
 * completion-sync — 完成核对（每拍前置）：工单在体外关闭 → 台账转 review + 飞书挪「C 待测试」+ 工单评论留痕
 *
 * 对齐器每拍先跑本模块，再做「待你处理」提醒——提醒读的是核对后的最新状态，
 * 僵尸任务（工单已关任务还挂 P/D）在数学上不会进入提醒。
 */
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";
import { SECTION_NAMES } from "@aigility-harness/layer-orchestration";

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

function giteaRefOf(t: { title: string; links?: Record<string, { guid?: string }>; origin?: { provider: string; guid: string } }): string | undefined {
  return (
    t.links?.["gitea-issue"]?.guid ??
    (t.origin?.provider === "gitea-issue" ? t.origin?.guid : undefined) ??
    t.title.match(/\[([^\]#/]+\/[^\]#/]+)#(\d+)\]/)?.slice(1, 3).join("#")
  );
}

async function callData<T>(call: Call, req: Record<string, unknown>): Promise<T | undefined> {
  const r = await call(req);
  if (!r.ok) return undefined;
  const v = r.value as { code?: number; status?: number; data?: unknown } | undefined;
  if (v?.code !== undefined && v.code !== 0) return undefined;
  if (v?.status !== undefined && (v.status < 200 || v.status >= 300)) return undefined;
  return v?.data as T;
}

async function giteaIssueState(call: Call, repo: string, n: number): Promise<string | undefined> {
  const d = await callData<{ state?: string }>(call, { method: "GET", path: `/repos/${repo}/issues/${n}` });
  return d?.state;
}

async function moveTaskToCheck(call: Call, taskGuid: string): Promise<boolean> {
  const lists = (await callData<{ items?: Array<{ name?: string; guid?: string }> }>(call, {
    path: "/open-apis/task/v2/tasklists",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }))?.items ?? [];
  for (const l of lists) {
    if (!l.guid) continue;
    const tasks = (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
      path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`,
      query: { completed: false, page_size: 100, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    if (!tasks.some((t) => (t.guid ?? t.task_id) === taskGuid)) continue;
    const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    let check = secs.find((s) => (s.name ?? "").trim() === SECTION_NAMES.check)?.guid;
    if (!check) {
      const cr = await call({
        method: "POST",
        path: "/open-apis/task/v2/sections",
        query: { user_id_type: "open_id" },
        identity: "user",
        body: { name: SECTION_NAMES.check, resource_type: "tasklist", resource_id: l.guid },
      });
      const v = cr.value as { code?: number; data?: { section?: { guid?: string } } } | undefined;
      check = cr.ok && (v?.code ?? -1) === 0 ? v?.data?.section?.guid : undefined;
    }
    if (!check) return false;
    const mv = await call({
      method: "POST",
      path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { tasklist_guid: l.guid, section_guid: check },
    });
    return mv.ok && ((mv.value as { code?: number })?.code ?? -1) === 0;
  }
  return false;
}

async function commentIssue(call: Call, repo: string, n: number, body: string): Promise<void> {
  await call({ method: "POST", path: `/repos/${repo}/issues/${n}/comments`, body: { body } }).catch?.(() => undefined);
}

/** 每拍完成核对。返回已同步的工单引用列表（供提醒/日志）。 */
export async function syncGiteaCompletions(
  registry: TaskRegistry,
  giteaCall: Call,
  feishuCall: Call,
): Promise<string[]> {
  const synced: string[] = [];
  const stateCache = new Map<string, string | undefined>();
  for (const t of registry.list({ status: ["planned", "ready", "dispatched", "running"] })) {
    const ref = giteaRefOf(t);
    if (!ref) continue;
    const hash = ref.lastIndexOf("#");
    if (hash <= 0) continue;
    const repo = ref.slice(0, hash);
    const n = Number(ref.slice(hash + 1));
    if (!Number.isFinite(n)) continue;

    let state = stateCache.get(ref);
    if (state === undefined) {
      state = await giteaIssueState(giteaCall, repo, n);
      stateCache.set(ref, state);
    }
    if (state !== "closed") continue;

    const tr = registry.transition(t.uid, "review");
    if (!tr.ok) continue; // 已在 review/其他：无需重复核对
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    let moved = "（无飞书镜像）";
    if (guid) moved = (await moveTaskToCheck(feishuCall, guid)) ? `飞书已挪「${SECTION_NAMES.check}」` : "飞书挪组失败";
    await commentIssue(giteaCall, repo, n, `🤖 完成核对：工单已关闭，任务自动进入「${SECTION_NAMES.check}」待验收。`);
    synced.push(`${ref}（${moved}）`);
  }
  return synced;
}
