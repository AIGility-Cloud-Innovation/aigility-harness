/**
 * assignee-sync — 负责人反向同步（每拍，完成核对之后跑）：体外负责人变化 → 台账 assignee_member_id
 *
 * 联动语义（负责人 2026-10-10 拍板「工单和飞书清单的任务对应负责人，也应该同步在台账」）：
 *   · 飞书任务 members[].role === "assignee"（名册 open_id → member_id）；
 *   · Gitea 工单 assignee/assignees（名册 gitea_username → member_id）——飞书无负责人时兜底；
 *   · 只回填（空 → 有），不覆盖人工在台账里已指定的负责人；只有体外明确「取消负责人」
 *     （曾同步过、现在两源都空）才清空，防误伤。
 * 查询失败一律跳过留待下拍（对齐器自动重试），不做破坏性假设。
 */
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";
import type { TaskRecord } from "@aigility-harness/core";
import { findMemberByFeishuOpenId, findMemberByGiteaUsername, getIdentityRegistry } from "@aigility-harness/layer-orchestration";

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown; status?: number };
  error?: string;
}>;

function callData<T>(call: Call, req: Record<string, unknown>): Promise<T | undefined> {
  return call(req).then((r) => {
    if (!r.ok) return undefined;
    const v = r.value as { code?: number; status?: number; data?: unknown } | undefined;
    if (v?.code !== undefined && v.code !== 0) return undefined;
    if (v?.status !== undefined && (v.status < 200 || v.status >= 300)) return undefined;
    return v?.data as T;
  });
}

interface FeishuAssignee {
  id?: string;
  role?: string;
}

async function feishuAssigneeOpenId(call: Call, taskGuid: string): Promise<string | undefined> {
  const d = await callData<{ task?: { members?: FeishuAssignee[] } }>(call, {
    method: "GET",
    path: `/open-apis/task/v2/tasks/${taskGuid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  return (d?.task?.members ?? []).find((m) => m.role === "assignee" && m.id)?.id;
}

async function giteaAssigneeNames(call: Call, repo: string, n: number): Promise<string[]> {
  const d = await callData<{ assignee?: { login?: string } | null; assignees?: Array<{ login?: string }> | null }>(call, {
    method: "GET",
    // path 带 /api/v1 前缀（provider 不自动补；漏了 404——2026-10-10 修）
    path: `/api/v1/repos/${repo}/issues/${n}`,
  });
  const names = [d?.assignee?.login, ...(d?.assignees ?? []).map((a) => a.login)].filter((x): x is string => !!x);
  return [...new Set(names)];
}

/** 工单 ref 解析（links 优先 → origin → 标题 [org/repo#N]），与 completion-sync 同型 */
function giteaRefOf(t: TaskRecord): { repo: string; n: number } | undefined {
  const ref =
    t.links?.["gitea-issue"]?.guid ??
    (t.origin?.provider === "gitea-issue" ? t.origin?.guid : undefined) ??
    t.title.match(/\[([^\]#/]+\/[^\]#/]+)#(\d+)\]/)?.slice(1, 3).join("#");
  if (!ref) return undefined;
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return undefined;
  const repo = ref.slice(0, hash);
  const n = Number(ref.slice(hash + 1));
  return Number.isFinite(n) && n > 0 ? { repo, n } : undefined;
}

/** 飞书任务 guid 解析（links 优先 → origin） */
function feishuGuidOf(t: TaskRecord): string | undefined {
  return t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
}

/** 体外负责人解析：飞书 assignee 优先（open_id→member_id），工单 assignee 兜底（login→member_id） */
async function externalAssigneeOf(
  t: TaskRecord,
  feishuCall: Call,
  giteaCall: Call,
  file: ReturnType<typeof getIdentityRegistry>,
): Promise<string | undefined> {
  const guid = feishuGuidOf(t);
  if (guid) {
    const openId = await feishuAssigneeOpenId(feishuCall, guid);
    if (openId) return findMemberByFeishuOpenId(file, openId)?.member_id;
  }
  const ref = giteaRefOf(t);
  if (ref) {
    for (const login of await giteaAssigneeNames(giteaCall, ref.repo, ref.n)) {
      const m = findMemberByGiteaUsername(file, login);
      if (m) return m.member_id;
    }
  }
  return undefined;
}

/** 每拍负责人反向同步。返回日志行（供 [align] 汇总）。 */
export async function syncAssignees(
  registry: TaskRegistry,
  feishuCall: Call,
  giteaCall: Call,
): Promise<string[]> {
  const log: string[] = [];
  const file = getIdentityRegistry();
  const records = registry.list();
  for (const t of records) {
    const guid = feishuGuidOf(t);
    const ref = giteaRefOf(t);
    if (!guid && !ref) continue; // 纯 digest 条目无体外负责人可同步
    const external = await externalAssigneeOf(t, feishuCall, giteaCall, file);
    if (external) {
      if (t.assignee_member_id === external) continue; // 已一致
      if (t.assignee_member_id) continue; // 台账已有（人工指定/历史同步）→ 不覆盖，防误伤
      const r = registry.update(t.uid, { assignee_member_id: external });
      if (r.ok) log.push(`${t.title.slice(0, 22)} → ${external}`);
    } else if (t.assignee_member_id && t.updatedAt) {
      // 曾有负责人、现在体外两源都空 → 体外已取消，跟随清空（null = 置空语义）
      const r = registry.update(t.uid, { assignee_member_id: null });
      if (r.ok) log.push(`${t.title.slice(0, 22)} → （体外已取消负责人，台账清空）`);
    }
  }
  return log;
}
