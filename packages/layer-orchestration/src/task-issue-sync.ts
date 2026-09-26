/**
 * L4 编排层: task-issue-sync —「项目小助理」业务域服务 + 工单/任务双建同步
 *
 * ③ 架构收法（2026-09-26 拍板）：业务逻辑全部下沉编排层，persona 只留脸
 * （正则解析 + 帮助文本 + 回复信封）。本服务承接原 persona 的全部意图处理
 * （飞书任务 / Gitea 工单 增删改查 + 项目概览），并新增 C 方案双向同步：
 *   - 建工单 @仓库 → Gitea 建单（查重/反问保留）→ 自动同步建飞书任务，
 *     挂到「组织名」任务清单（清单不存在自动创建；部分失败不回滚，回执注明）
 *   - 建任务 @仓库 → 飞书建任务 → 自动同步建 Gitea 工单（同样查重）
 *     ；未带 @仓库 → 不写任何数据，反问可访问仓库（与建工单对称）
 *   - 挂清单端点（真机验证）：POST /open-apis/task/v2/tasks/:guid/add_tasklist
 *     body {tasklist_guid}（挂在任务维度，文档未收录，SDK 源码考证）
 *
 * 单一真相：task-pipeline 被动流水线自动建单后，经 sync-issue 模式调同一份
 * 飞书同步逻辑；主动指令与被动流水线不再各自维护同步代码。
 *
 * 只管理，不执行：本服务不写代码，执行由 codex 系工人/真人完成。
 */

import {
  LayerId,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// ── 消费引用 ─────────────────────────────────────────────────────

/** 消费行动层飞书 Open API 直连能力 */
export const feishuApiRef: CapabilityRef = {
  id: "@action/feishu-api",
  versionRange: "^1.0.0",
};

/** 消费行动层 Gitea v1 API 直连能力 */
export const giteaApiRef: CapabilityRef = {
  id: "@action/gitea-api",
  versionRange: "^1.0.0",
};

// ── 意图词汇表（persona 解析产出、本服务消费；类型随服务契约走编排层） ──

export type TaskIntent =
  | { kind: "create"; title: string; dueDate?: string; repo?: string }
  | { kind: "list" }
  | { kind: "complete"; keyword: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string }
  | { kind: "issue-list"; repo?: string }
  | { kind: "issue-show"; repo?: string; ref: string }
  | { kind: "issue-close"; repo?: string; ref: string }
  | { kind: "issue-reopen"; repo?: string; ref: string }
  | { kind: "issue-comment"; repo?: string; ref: string; comment: string }
  /** 建工单未指定仓库：反问并列出可访问仓库（不发任何写请求） */
  | { kind: "issue-need-repo"; title: string; body?: string }
  /** 建任务未指定仓库（C 方案要求同步建工单）：反问，不写任何数据 */
  | { kind: "task-need-repo"; title: string; dueDate?: string }
  | { kind: "overview" }
  | { kind: "help" };

// ── 请求/响应 ────────────────────────────────────────────────────

export type TaskIssueSyncRequest =
  | {
      /** 意图模式：persona 解析后委托业务处理，返回用户回复文本 */
      mode: "intent";
      intent: TaskIntent;
      session_id?: string;
    }
  | {
      /** 原语模式：给 task-pipeline 等调用方复用「工单→飞书任务」单向同步 */
      mode: "sync-issue";
      /** 仓库 full_name（org/仓库） */
      repo: string;
      issue: { number?: number; title?: string; html_url?: string };
    };

export interface TaskIssueSyncResponse {
  /** 用户回复文本（intent 模式）或同步结果摘要（sync-issue 模式） */
  response: string;
  session_id?: string;
}

export const taskIssueSyncService: ServiceDefinition<
  TaskIssueSyncRequest,
  TaskIssueSyncResponse
> = {
  id: "@orchestration/task-issue-sync",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "项目小助理业务域：飞书任务/Gitea 工单增删改查 + 双建同步（org→任务清单，部分失败不回滚）",
};

// ── 上游 API 的局部 shape（不引用行动层类型，层间解耦） ────────────

interface FeishuApiResultLike {
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown };
  error?: string;
}

interface GiteaApiResultLike {
  ok: boolean;
  value?: { status: number; data?: unknown };
  error?: string;
}

interface TaskLike {
  task_id?: string;
  guid?: string;
  summary?: string;
  description?: string;
  status?: string;
  url?: string;
  due?: { date?: string };
}

export interface IssueLike {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  labels?: { name?: string }[];
}

interface TasklistLike {
  guid?: string;
  name?: string;
}

// ── 文本格式化（导出供单测；自 persona 迁入） ─────────────────────

const STATUS_LABEL: Record<string, string> = {
  todo: "☐ 待办",
  done: "✅ 已完成",
};

export function formatTaskLine(t: TaskLike, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const status = STATUS_LABEL[t.status ?? "todo"] ?? t.status ?? "";
  const due = t.due?.date ? `（截止 ${t.due.date}）` : "";
  return `${prefix}${status} ${t.summary?.trim() ?? "(无标题)"}${due}`;
}

export function formatTaskList(tasks: TaskLike[]): string {
  if (tasks.length === 0) return "当前没有任务，发「建任务：<标题>」即可创建。";
  const lines = tasks.map((t, i) => formatTaskLine(t, i + 1));
  return `共 ${tasks.length} 条任务：\n${lines.join("\n")}`;
}

const ISSUE_STATE_LABEL: Record<string, string> = {
  open: "🟢 进行中",
  closed: "✅ 已关闭",
};

export function issueLabels(i: IssueLike): string {
  return (i.labels ?? [])
    .map((l) => l.name?.trim())
    .filter((n): n is string => Boolean(n))
    .join("·");
}

export function formatIssueLine(i: IssueLike, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const state = ISSUE_STATE_LABEL[i.state ?? "open"] ?? i.state ?? "";
  const labels = issueLabels(i);
  const tag = labels ? `（${labels}）` : "";
  return `${prefix}${state} #${i.number ?? "?"} ${i.title?.trim() ?? "(无标题)"}${tag}`;
}

export function formatIssueList(issues: IssueLike[]): string {
  if (issues.length === 0) return "当前没有进行中的工单，发「建工单：<标题>」即可创建。";
  const lines = issues.map((i, idx) => formatIssueLine(i, idx + 1));
  return `共 ${issues.length} 条工单：\n${lines.join("\n")}`;
}

export function formatIssueDetail(i: IssueLike): string {
  const state = ISSUE_STATE_LABEL[i.state ?? "open"] ?? i.state ?? "";
  const labels = issueLabels(i);
  return [
    `#${i.number ?? "?"} ${i.title?.trim() ?? "(无标题)"}`,
    `状态：${state}${labels ? `\n标签：${labels}` : ""}`,
    i.html_url ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 按 ref（#编号/纯数字 → 精确匹配；否则标题关键字包含）在工单列表中找目标 */
export function matchIssueByRef(issues: IssueLike[], ref: string): IssueLike | undefined {
  const m = ref.trim().match(/^#?(\d+)$/);
  if (m) return issues.find((i) => String(i.number) === m[1]);
  const kw = ref.trim().toLowerCase();
  return issues.find((i) => (i.title ?? "").toLowerCase().includes(kw));
}

/** 双建同步的飞书任务标题：[org/repo#N] 标题（可反查工单） */
export function syncTaskSummary(repo: string, issue: { number?: number; title?: string }): string {
  return `[${repo}#${issue.number ?? "?"}] ${issue.title?.trim() ?? ""}`.trimEnd();
}

/** 工单仓库所属组织 → 飞书任务清单名（org 对应清单） */
export function tasklistNameForRepo(repo: string): string {
  return repo.split("/")[0] ?? repo;
}

// ── API 轻量封装（自 persona 迁入） ──────────────────────────────

async function callFeishuApi(
  ctx: SeamContext,
  req: Record<string, unknown>,
): Promise<FeishuApiResultLike> {
  const r = (await ctx.call(
    { id: "@action/feishu-api", versionRange: "^1.0.0" },
    req,
  )) as FeishuApiResultLike;
  return r;
}

async function callGiteaApi(
  ctx: SeamContext,
  req: Record<string, unknown>,
): Promise<GiteaApiResultLike> {
  const r = (await ctx.call(
    { id: "@action/gitea-api", versionRange: "^1.0.0" },
    req,
  )) as GiteaApiResultLike;
  return r;
}

/**
 * 工单操作的目标仓库：意图显式 @仓库 优先（短名在此前已解析为 full_name），
 * 未指定回落 GITEA_DEFAULT_REPO（查询类意图的兜底；建单/建任务不走兜底——
 * 仓库必填，缺省在解析层即转 need-repo 反问）
 */
function giteaRepo(explicit?: string): string {
  return explicit ?? process.env.GITEA_DEFAULT_REPO ?? "TiMEM-AI/timem-platform-backend";
}

function issuesBaseFor(repo?: string): string {
  return `/api/v1/repos/${giteaRepo(repo)}/issues`;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** token 可访问的活跃仓库（按最近更新排序，供反问提示与短名解析） */
async function candidateRepos(ctx: SeamContext): Promise<string[]> {
  const r = await callGiteaApi(ctx, {
    method: "GET",
    path: "/api/v1/repos/search",
    query: { sort: "updated", order: "desc", limit: 20 },
  });
  if (!r.ok || !is2xx(r.value?.status ?? 0)) return [];
  // gitea-api provider 把 {ok, data:[...]} 响应体整体作为 data 返回，剥一层
  const payload = r.value?.data as
    | { ok?: boolean; data?: { full_name?: string }[] }
    | { full_name?: string }[]
    | undefined;
  const items = Array.isArray(payload) ? payload : (payload?.data ?? []);
  return items.map((x) => x.full_name ?? "").filter(Boolean);
}

/**
 * 把用户输入的仓库片段解析为 full_name：
 *   - 含 / ：直接当作 组织/仓库 使用
 *   - 不含 / ：当作仓库短名/别名，先精确匹配仓库名，再唯一子串匹配
 *     （@video → nx-telecom-video-platform）；0 个或多个命中返回
 *     undefined（建单/建任务走反问澄清，查询类回落默认仓库）
 */
async function resolveRepoInput(
  ctx: SeamContext,
  input: string,
): Promise<string | undefined> {
  if (input.includes("/")) return input;
  const repos = await candidateRepos(ctx);
  const kw = input.toLowerCase();
  const exact = repos.filter((r) => r.toLowerCase().split("/")[1] === kw);
  if (exact.length === 1) return exact[0];
  const fuzzy = repos.filter((r) => r.toLowerCase().split("/")[1].includes(kw));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

/** 查询单条工单：ref 为编号时直取详情，关键字时列表匹配（返回 undefined=未找到） */
async function findIssue(
  ctx: SeamContext,
  repo: string | undefined,
  ref: string,
): Promise<{ issue?: IssueLike; error?: string }> {
  const num = ref.match(/^#?(\d+)$/);
  if (num) {
    const r = await callGiteaApi(ctx, { method: "GET", path: `${issuesBaseFor(repo)}/${num[1]}` });
    if (!r.ok) return { error: r.error };
    if (!is2xx(r.value?.status ?? 0)) return { error: `HTTP ${r.value?.status}` };
    return { issue: r.value?.data as IssueLike };
  }
  const r = await callGiteaApi(ctx, {
    method: "GET",
    path: issuesBaseFor(repo),
    query: { state: "all", limit: 50, type: "issues" },
  });
  if (!r.ok) return { error: r.error };
  if (!is2xx(r.value?.status ?? 0)) return { error: `HTTP ${r.value?.status}` };
  const items = (r.value?.data as IssueLike[]) ?? [];
  return { issue: matchIssueByRef(items, ref) };
}

/** 仓库必填的反问（工单/任务共用）：不发任何写请求，实时拉取可访问仓库做候选 */
async function askForRepo(ctx: SeamContext, verb: string, title: string): Promise<string> {
  const repos = await candidateRepos(ctx);
  const list = repos.length
    ? repos.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "（暂无法获取仓库列表，请直接用 @组织/仓库 全名重发）";
  return [
    `请指定仓库（${verb}必须 @仓库，双向同步建单），把命令重发一遍带上即可：`,
    `「${verb} @组织/仓库：${title}」`,
    ``,
    `最近活跃的可访问仓库：`,
    list,
  ].join("\n");
}

// ── 飞书任务清单（org→清单映射：按名字解析，缺则自动创建） ─────────

/** 进程内清单名→guid 缓存（避免每单都拉全量清单；重启即失效可接受） */
const tasklistGuidCache = new Map<string, string>();

async function findTasklistByName(ctx: SeamContext, name: string): Promise<TasklistLike | undefined> {
  const r = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/tasklists",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) return undefined;
  const items = (r.value?.data as { items?: TasklistLike[] })?.items ?? [];
  const hit = items.find((t) => (t.name ?? "").toLowerCase() === name.toLowerCase());
  return hit;
}

async function ensureTasklist(ctx: SeamContext, name: string): Promise<{ guid?: string; error?: string }> {
  const cached = tasklistGuidCache.get(name);
  if (cached) return { guid: cached };
  const hit = await findTasklistByName(ctx, name);
  if (hit?.guid) {
    tasklistGuidCache.set(name, hit.guid);
    return { guid: hit.guid };
  }
  // 不存在 → 自动创建（org 对应清单）
  const cr = await callFeishuApi(ctx, {
    method: "POST",
    path: "/open-apis/task/v2/tasklists",
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { name },
  });
  if (!cr.ok || (cr.value?.code ?? -1) !== 0) {
    return { error: cr.ok ? cr.value?.msg || `code=${cr.value?.code}` : cr.error };
  }
  const guid = (cr.value?.data as { tasklist?: TasklistLike })?.tasklist?.guid;
  if (!guid) return { error: "创建清单成功但未返回 guid" };
  tasklistGuidCache.set(name, guid);
  return { guid };
}

/**
 * 工单 → 飞书任务同步（双建核心，主动/被动共用）：
 * 建任务（带 [repo#N] 标题，正文放工单链接）→ 挂到 org 清单。
 * 部分失败返回 error 文本，不抛异常、不回滚已建工单。
 */
async function syncIssueToTask(
  ctx: SeamContext,
  repo: string,
  issue: { number?: number; title?: string; html_url?: string },
): Promise<{ ok: boolean; detail: string }> {
  const listName = tasklistNameForRepo(repo);
  const list = await ensureTasklist(ctx, listName);
  if (list.error || !list.guid) {
    return { ok: false, detail: `清单「${listName}」不可用：${list.error}` };
  }
  const body: Record<string, unknown> = { summary: syncTaskSummary(repo, issue) };
  if (issue.html_url) body.description = `工单链接：${issue.html_url}`;
  const tr = await callFeishuApi(ctx, {
    method: "POST",
    path: "/open-apis/task/v2/tasks",
    query: { user_id_type: "open_id" },
    identity: "user",
    body,
  });
  if (!tr.ok || (tr.value?.code ?? -1) !== 0) {
    return { ok: false, detail: `建任务失败：${tr.ok ? tr.value?.msg || `code=${tr.value?.code}` : tr.error}` };
  }
  const task = (tr.value?.data as { task?: TaskLike })?.task;
  const taskGuid = task?.guid ?? task?.task_id;
  if (!taskGuid) return { ok: false, detail: "建任务成功但未返回 guid，未挂清单" };
  // 挂清单（真机验证端点：任务维度 add_tasklist）
  const ar = await callFeishuApi(ctx, {
    method: "POST",
    path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { tasklist_guid: list.guid },
  });
  if (!ar.ok || (ar.value?.code ?? -1) !== 0) {
    return {
      ok: false,
      detail: `任务已建但挂清单「${listName}」失败：${ar.ok ? ar.value?.msg || `code=${ar.value?.code}` : ar.error}`,
    };
  }
  return { ok: true, detail: `已同步飞书任务并挂清单「${listName}」` };
}

// ── 意图处理（自 persona 迁入；建单/建任务接入双建同步） ──────────

/** 工单意图处理（增删改查 + 评论）；repo=意图显式 @仓库（短名在此解析为 full_name） */
async function handleIssueIntent(
  intent: Extract<TaskIntent, { kind: `issue-${string}` } | { kind: "issue-need-repo" }>,
  ctx: SeamContext,
): Promise<string> {
  const rawRepo = "repo" in intent ? intent.repo : undefined;
  const repo = rawRepo ? await resolveRepoInput(ctx, rawRepo) : undefined;

  if (intent.kind === "issue-need-repo") {
    return askForRepo(ctx, "建工单", intent.title);
  }

  if (intent.kind === "issue-create") {
    // 短名解析失败（0 或多个命中）同样反问，不猜仓库
    if (!repo) return askForRepo(ctx, "建工单", intent.title);
    // 操作惯例：创建前查重（state=all 比对标题），避免重复工单
    const dup = await findIssue(ctx, repo, intent.title);
    if (dup.error) return `❌ 建工单前查重失败：${dup.error}`;
    if (dup.issue) {
      return `已有同名工单，不重复创建：\n${formatIssueDetail(dup.issue)}`;
    }
    const body: Record<string, unknown> = { title: intent.title };
    if (intent.body) body.body = intent.body;
    const r = await callGiteaApi(ctx, { method: "POST", path: issuesBaseFor(repo), body });
    if (!r.ok || !is2xx(r.value?.status ?? 0)) {
      return `❌ 建工单失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
    }
    const created = r.value?.data as IssueLike;
    // ── C 方案双向同步：工单建成功 → 飞书任务挂 org 清单（部分失败不回滚） ──
    const sync = await syncIssueToTask(ctx, repo, created ?? { title: intent.title });
    const syncLine = sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`;
    return `✅ 已建工单 ${giteaRepo(repo)} #${created?.number}：${created?.title ?? intent.title}${
      intent.body ? "（含正文）" : ""
    }\n${created?.html_url ?? ""}\n${syncLine}`.trimEnd();
  }

  if (intent.kind === "issue-list") {
    const r = await callGiteaApi(ctx, {
      method: "GET",
      path: issuesBaseFor(repo),
      query: { state: "open", limit: 20, type: "issues" },
    });
    if (!r.ok || !is2xx(r.value?.status ?? 0)) {
      return `❌ 查询工单失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
    }
    const items = (r.value?.data as IssueLike[]) ?? [];
    return formatIssueList(items.slice(0, 10));
  }

  if (intent.kind === "issue-show") {
    const { issue, error } = await findIssue(ctx, repo, intent.ref);
    if (error) return `❌ 查询工单失败：${error}`;
    if (!issue) return `没有找到与「${intent.ref}」匹配的工单。可用 #编号 或标题关键字。`;
    return formatIssueDetail(issue);
  }

  if (intent.kind === "issue-close" || intent.kind === "issue-reopen") {
    const closing = intent.kind === "issue-close";
    const { issue, error } = await findIssue(ctx, repo, intent.ref);
    if (error) return `❌ 查询工单失败：${error}`;
    if (!issue) return `没有找到与「${intent.ref}」匹配的工单。发「工单列表」查看现有工单。`;
    const targetState = closing ? "closed" : "open";
    if ((issue.state ?? "open") === targetState) {
      return `工单 #${issue.number} 已经是${closing ? "关闭" : "打开"}状态：${issue.title?.trim()}`;
    }
    // PATCH：本实例返回 201 而非 200（怪癖但生效），以响应体 state 做写后验证
    const r = await callGiteaApi(ctx, {
      method: "PATCH",
      path: `${issuesBaseFor(repo)}/${issue.number}`,
      body: { state: targetState },
    });
    const patched = r.value?.data as IssueLike | undefined;
    if (!r.ok || !is2xx(r.value?.status ?? 0) || patched?.state !== targetState) {
      return `❌ ${closing ? "关闭" : "重开"}工单失败：${
        r.ok ? `HTTP ${r.value?.status}${patched ? ` state=${patched.state}` : ""}` : r.error
      }`;
    }
    return `✅ 已${closing ? "关闭" : "重开"}工单 #${patched?.number}：${patched?.title?.trim()}`;
  }

  // issue-comment（ref 已由正则约束为编号）
  const r = await callGiteaApi(ctx, {
    method: "POST",
    path: `${issuesBaseFor(repo)}/${intent.ref}/comments`,
    body: { body: intent.comment },
  });
  if (!r.ok || !is2xx(r.value?.status ?? 0)) {
    return `❌ 评论工单失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
  }
  return `✅ 已评论工单 #${intent.ref}：${intent.comment.slice(0, 30)}${
    intent.comment.length > 30 ? "…" : ""
  }`;
}

/** 项目概览：飞书待办 + 进行中工单（单侧失败降级不影响另一侧） */
async function buildOverview(ctx: SeamContext): Promise<string> {
  const [taskR, issueR] = await Promise.all([
    callFeishuApi(ctx, {
      method: "GET",
      path: "/open-apis/task/v2/tasks",
      query: { page_size: 20, user_id_type: "open_id" },
      identity: "user",
    }),
    callGiteaApi(ctx, {
      method: "GET",
      path: issuesBaseFor(),
      query: { state: "open", limit: 10, type: "issues" },
    }),
  ]);

  const parts: string[] = ["📊 项目概览"];

  if (taskR.ok && (taskR.value?.code ?? -1) === 0) {
    const tasks = ((taskR.value?.data as { items?: TaskLike[] })?.items ?? []).filter(
      (t) => t.status !== "done",
    );
    const top = tasks.slice(0, 5);
    parts.push(
      `📋 飞书待办（${tasks.length}）：\n${
        top.length ? top.map((t, i) => formatTaskLine(t, i + 1)).join("\n") : "（无）"
      }`,
    );
  } else {
    parts.push(`📋 飞书待办：查询失败（${taskR.ok ? taskR.value?.msg : taskR.error}）`);
  }

  if (issueR.ok && is2xx(issueR.value?.status ?? 0)) {
    const issues = (issueR.value?.data as IssueLike[]) ?? [];
    const top = issues.slice(0, 5);
    parts.push(
      `🎫 进行中工单（${issues.length}）：\n${
        top.length ? top.map((i, idx) => formatIssueLine(i, idx + 1)).join("\n") : "（无）"
      }`,
    );
  } else {
    parts.push(
      `🎫 进行中工单：查询失败（${issueR.ok ? `HTTP ${issueR.value?.status}` : issueR.error}）`,
    );
  }

  return parts.join("\n\n");
}

/** 飞书任务意图处理（C 方案：建任务双向同步建工单，@仓库必填） */
async function handleTaskIntent(
  intent: Extract<TaskIntent, { kind: "create" | "list" | "complete" | "task-need-repo" }>,
  ctx: SeamContext,
): Promise<string> {
  if (intent.kind === "task-need-repo") {
    return askForRepo(ctx, "建任务", intent.title);
  }

  if (intent.kind === "create") {
    // C 方案：建任务必须带 @仓库（双向同步建工单）；缺仓反问不写数据
    if (!intent.repo) return askForRepo(ctx, "建任务", intent.title);
    const repo = await resolveRepoInput(ctx, intent.repo);
    if (!repo) return askForRepo(ctx, "建任务", intent.title);

    // 工单侧先查重：同名工单已存在则只建飞书任务，不重复建单
    const dup = await findIssue(ctx, repo, intent.title);
    if (dup.error) return `❌ 建任务前查重失败：${dup.error}`;

    const body: Record<string, unknown> = { summary: intent.title };
    if (intent.dueDate) {
      body.due = { is_all_day: true, date: `${intent.dueDate}T00:00:00+08:00` };
    }
    const r = await callFeishuApi(ctx, {
      method: "POST",
      path: "/open-apis/task/v2/tasks",
      query: { user_id_type: "open_id" },
      identity: "user",
      body,
    });
    if (!r.ok || (r.value?.code ?? -1) !== 0) {
      let response = `❌ 创建任务失败：${r.ok ? r.value?.msg || `code=${r.value?.code}` : r.error}`;
      // 续期失效的引导
      if (r.error?.includes("OAuth")) response += "\n（提示：需要重新完成一次飞书授权）";
      return response;
    }
    const t = (r.value?.data as { task?: TaskLike })?.task;
    const taskLine = `✅ 已创建任务：${t?.summary ?? intent.title}${intent.dueDate ? `（截止 ${intent.dueDate}）` : ""}`;

    if (dup.issue) {
      return `${taskLine}\n⚠️ ${repo} 已有同名工单（不重复建）：#${dup.issue.number} ${dup.issue.title?.trim()}`;
    }
    // 工单侧同步创建（部分失败不回滚已建任务）
    const ir = await callGiteaApi(ctx, {
      method: "POST",
      path: issuesBaseFor(repo),
      body: {
        title: intent.title,
        ...(intent.dueDate ? { body: `> 来源：飞书任务双向同步（截止 ${intent.dueDate}）` } : {}),
      },
    });
    if (!ir.ok || !is2xx(ir.value?.status ?? 0)) {
      return `${taskLine}\n⚠️ Gitea 工单同步失败：${ir.ok ? `HTTP ${ir.value?.status}` : ir.error}`;
    }
    const issue = ir.value?.data as IssueLike;
    // 工单建成功 → 顺手把飞书任务挂 org 清单（幂等补挂，失败不阻塞回执）
    const sync = await syncIssueToTask(ctx, repo, issue ?? {});
    const syncLine = sync.ok ? `📋 ${sync.detail}` : `⚠️ ${sync.detail}`;
    return `${taskLine}\n🎫 已同步建工单 ${repo} #${issue?.number}：${issue?.title ?? intent.title}\n${
      issue?.html_url ?? ""
    }\n${syncLine}`.trimEnd();
  }

  if (intent.kind === "list") {
    const r = await callFeishuApi(ctx, {
      method: "GET",
      path: "/open-apis/task/v2/tasks",
      query: { page_size: 20, user_id_type: "open_id" },
      identity: "user",
    });
    if (!r.ok || (r.value?.code ?? -1) !== 0) {
      return `❌ 查询任务失败：${r.ok ? r.value?.msg || `code=${r.value?.code}` : r.error}`;
    }
    const items = ((r.value?.data as { items?: TaskLike[] })?.items ?? []).filter(
      (t) => t.status !== "done",
    );
    return formatTaskList(items.slice(0, 10));
  }

  // complete：查列表 → 匹配关键字 → PATCH completed
  const kw = intent.keyword.toLowerCase();
  const listR = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/tasks",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  const items = listR.ok
    ? ((listR.value?.data as { items?: TaskLike[] })?.items ?? [])
    : [];
  const target = items.find(
    (t) =>
      t.status !== "done" &&
      ((t.summary ?? "").toLowerCase().includes(kw) ||
        t.task_id?.toLowerCase() === kw),
  );
  if (!target) {
    return `没有找到与「${intent.keyword}」匹配的未完成任务。发「我的任务」查看现有任务。`;
  }
  const patchR = await callFeishuApi(ctx, {
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${target.task_id}`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { completed_at: new Date().toISOString() },
  });
  if (!patchR.ok || (patchR.value?.code ?? -1) !== 0) {
    return `❌ 完结任务失败：${patchR.ok ? patchR.value?.msg || `code=${patchR.value?.code}` : patchR.error}`;
  }
  return `✅ 已完成：${target.summary?.trim()}`;
}

// ── Provider 实现 ────────────────────────────────────────────────

const taskIssueSyncProvider: Provider<TaskIssueSyncRequest, TaskIssueSyncResponse> = {
  service: taskIssueSyncService,
  name: "orchestration-task-issue-sync",
  state: PluginState.Active,

  async execute(
    request: TaskIssueSyncRequest,
    ctx: SeamContext,
  ): Promise<Result<TaskIssueSyncResponse>> {
    if (request.mode === "sync-issue") {
      // 原语模式：task-pipeline 自动建单后的单向同步（失败返回文本不抛错）
      const sync = await syncIssueToTask(ctx, request.repo, request.issue);
      return ok({
        response: sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`,
      });
    }

    const intent = request.intent;
    let response: string;
    if (intent.kind === "help") {
      response = "（帮助文本由 persona 层提供）";
    } else if (intent.kind === "overview") {
      response = await buildOverview(ctx);
    } else if (intent.kind === "task-need-repo" || intent.kind === "create" || intent.kind === "list" || intent.kind === "complete") {
      response = await handleTaskIntent(intent, ctx);
    } else {
      response = await handleIssueIntent(intent, ctx);
    }
    return ok({ response, session_id: request.session_id ?? ctx.sessionId });
  },

  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "task-issue-sync ready（任务/工单业务域 + 双建同步）",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { taskIssueSyncProvider };
