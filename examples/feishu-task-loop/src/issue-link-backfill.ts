/**
 * issue-link-backfill — 工单链接回填（对齐器每拍，完成核对之后）
 *
 * 负责人需求（2026-10-10）：带工单的任务，工单链接要贴在飞书任务描述里，
 * 且跟着某个定时任务一起定期补——不用单独起拍子。
 *
 * 挂点：index.ts 对齐器 onReport（TASK_ALIGN_INTERVAL_MS，默认 30 分钟/拍），
 * 排在 syncGiteaCompletions / syncAssignees / syncBoardAlignment 之后。
 *
 * 口径（只补不建，建单归 plan-gate/回填工单链路）：
 *   · 扫非终态台账任务（planned/ready/dispatched/running）；
 *   · 工单引用取 giteaRefOf 同款（links["gitea-issue"] / origin / 标题前缀）；
 *   · 飞书任务描述缺「工单链接：」→ GET 工单拿 html_url → PATCH 追加到描述末尾；
 *   · 幂等：已有链接不重复补；描述为空则新建「工单链接：…」；
 *   · 工单查不到（404/非 2xx）跳过并 console.warn，不阻塞其他任务。
 *
 * 2026-10-10 实测修正：飞书清单里带 [repo#N] 的任务（工单双建产物）多数没有
 * 台账镜像——不能只扫台账。改为双通道：① 台账记录（有 feishu-task guid 的）；
 * ② 直接扫飞书各 org 清单的 D 组（标题带 [repo#N] 的任务）。两者都补。
 */
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

const LINK_MARK = "工单链接：";

function giteaRefOf(t: { title: string; links?: Record<string, { guid?: string }>; origin?: { provider: string; guid: string } }): string | undefined {
  return (
    t.links?.["gitea-issue"]?.guid ??
    (t.origin?.provider === "gitea-issue" ? t.origin?.guid : undefined) ??
    // 标题 [org/repo#N] → "org/repo#N"（不能用 slice(1,3).join("#")：那会生成 org#repo 丢工单号）
    (() => {
      const m = t.title.match(/\[([^\]#/]+)\/([^\]#/]+)#(\d+)\]/);
      return m ? `${m[1]}/${m[2]}#${m[3]}` : undefined;
    })()
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

/** 每拍回填。返回回填明细（供日志）；无待补时返回空数组。 */
export async function backfillIssueLinks(
  registry: TaskRegistry,
  giteaCall: Call,
  feishuCall: Call,
  feishuTasklists?: string[],
): Promise<string[]> {
  const filled: string[] = [];
  const seen = new Set<string>();

  // 通道②：直接扫飞书各 org 清单的 D 组（带 [repo#N] 的工单双建任务）——它们多数没有台账镜像
  if (feishuTasklists?.length) {
    const lists = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(feishuCall, {
      method: "GET",
      path: "/open-apis/task/v2/tasklists",
      query: { page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
    for (const list of lists) {
      if (!feishuTasklists.includes(list.name ?? "")) continue;
      const secs = (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(feishuCall, {
        method: "GET",
        path: "/open-apis/task/v2/sections",
        query: { resource_type: "tasklist", resource_id: list.guid, page_size: 50, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      const doing = secs.find((s) => (s.name ?? "").trim() === "D 执行中")?.guid;
      if (!doing) continue;
      const tasks = (await callData<{ items?: Array<{ guid?: string; summary?: string }> }>(feishuCall, {
        method: "GET",
        path: `/open-apis/task/v2/sections/${doing}/tasks`,
        query: { page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
      for (const t of tasks) {
        const ref = giteaRefOf({ title: t.summary ?? "" });
        if (!ref || !t.guid || seen.has(t.guid)) continue;
        seen.add(t.guid);
        const r = await fillOne(giteaCall, feishuCall, t.guid, ref, `${t.summary ?? ""}`.slice(0, 40));
        if (r) filled.push(r);
      }
    }
  }

  // 通道①：台账记录（有 feishu-task guid 的）
  for (const t of registry.list({ status: ["planned", "ready", "dispatched", "running"] })) {
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    const ref = giteaRefOf(t);
    if (!guid || !ref || seen.has(guid)) continue;
    seen.add(guid);
    const r = await fillOne(giteaCall, feishuCall, guid, ref, t.title.slice(0, 40));
    if (r) filled.push(r);
  }
  return filled;
}

/** 单任务补链：查现状描述 → 查工单 html_url → PATCH 追加。返回回填描述或 undefined（无需补/失败）。 */
async function fillOne(
  giteaCall: Call,
  feishuCall: Call,
  guid: string,
  ref: string,
  label: string,
): Promise<string | undefined> {
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return undefined;
  const repo = ref.slice(0, hash);
  const n = Number(ref.slice(hash + 1));
  if (!Number.isFinite(n) || !repo) return undefined;

  // ① 飞书任务现状描述
  const cur = await callData<{ task?: { description?: string } }>(feishuCall, {
    method: "GET",
    path: `/open-apis/task/v2/tasks/${guid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  const desc = cur?.task?.description ?? "";
  if (desc.includes(LINK_MARK)) return undefined; // 幂等：已有链接（人工补过/上拍补过）跳过

  // ② 工单 html_url
  const issue = await callData<{ html_url?: string }>(giteaCall, {
    method: "GET",
    path: `/api/v1/repos/${repo}/issues/${n}`,
  });
  const url = issue?.html_url;
  if (!url) {
    console.warn(`[link-backfill] 工单 ${repo}#${n} 取链接失败（跳过，下拍重试）`);
    return undefined;
  }

  // ③ PATCH 描述（原描述末尾追加，空描述则新建；不截断任何已有内容）
  const next = desc ? `${desc}\n${LINK_MARK}${url}` : `${LINK_MARK}${url}`;
  const pr = await callData<unknown>(feishuCall, {
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${guid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { update_fields: ["description"], task: { description: next } },
  });
  if (pr === undefined) {
    console.warn(`[link-backfill] 任务 ${guid.slice(0, 13)} 描述回写失败（下拍重试）`);
    return undefined;
  }
  return `${ref} → ${label}`;
}
