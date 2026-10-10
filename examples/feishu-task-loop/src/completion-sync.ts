/**
 * completion-sync — 完成核对（每拍前置）：双源联动关闭台账
 *
 * 联动语义（负责人 2026-10-10 拍板「关闭飞书任务或者git工单时，应该联动关闭台账」）：
 *   · Gitea 工单在体外关闭 → 台账转 review（待验收）+ 飞书挪「C 待测试」+ 工单评论留痕；
 *   · 飞书任务在体外完成（completed_at > 0，多为人工在飞书点完成=验收）→ 台账直接转 done；
 *   · 工单已关 + 飞书已完成 → done（验收闭环，不留 review）。
 *
 * 对齐器每拍先跑本模块，再做「待你处理」提醒——提醒读的是核对后的最新状态，
 * 僵尸任务（工单已关/飞书已完成任务还挂 P/D/review）在数学上不会进入提醒。
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

/** 飞书任务是否已完成（completed_at > 0）——查询失败按「未完成」处理，留给下拍重试 */
async function feishuTaskCompleted(call: Call, taskGuid: string): Promise<boolean> {
  const d = await callData<{ task?: { completed_at?: string | number } }>(call, {
    method: "GET",
    path: `/open-apis/task/v2/tasks/${taskGuid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  const ca = d?.task?.completed_at;
  return ca !== undefined && ca !== null && Number(ca) > 0;
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
      query: { page_size: 100, user_id_type: "open_id" }, // 不带 completed 参数（间歇返回空列表），代码内过滤
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
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    const ref = giteaRefOf(t);
    // ① 飞书任务体外完成 → 验收，台账落 done（不论有无工单；running→done 直达，其余经 review 两跳合法路径）
    if (guid && (await feishuTaskCompleted(feishuCall, guid))) {
      const okDone =
        registry.transition(t.uid, "done").ok ||
        (registry.transition(t.uid, "review").ok && registry.transition(t.uid, "done", "review").ok);
      if (okDone) {
        synced.push(`${ref ?? t.title.slice(0, 24)}（飞书已完成 → done）`);
        continue;
      }
    }
    // ② 工单体外关闭（飞书镜像未完成）→ review + 飞书挪「C 待测试」+ 留痕
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
    let moved = "（无飞书镜像）";
    if (guid) moved = (await moveTaskToCheck(feishuCall, guid)) ? `飞书已挪「${SECTION_NAMES.check}」` : "飞书挪组失败";
    await commentIssue(giteaCall, repo, n, `🤖 完成核对：工单已关闭，任务自动进入「${SECTION_NAMES.check}」待验收。`);
    synced.push(`${ref}（${moved}）`);
  }

  // ③ review 阶段二次核对：待验收条目的飞书镜像被人工点完成 = 验收通过 → done
  //   （工单已关 + 飞书完成的双源闭环；只处理 review，drift 由对齐器另行处理）
  for (const t of registry.list({ status: ["review"] })) {
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    if (!guid) continue;
    if (!(await feishuTaskCompleted(feishuCall, guid))) continue;
    const tr = registry.transition(t.uid, "done", "review");
    if (!tr.ok) continue;
    const ref = giteaRefOf(t);
    synced.push(`${ref ?? t.title.slice(0, 24)}（待验收中飞书已完成 → done）`);
  }
  return synced;
}
