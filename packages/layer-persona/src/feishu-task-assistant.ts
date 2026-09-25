/**
 * L3 角色人格层: feishu-task-assistant —「项目小助理」协调人格
 *
 * 定位：只做飞书任务与 Gitea 工单的【管理协调】（增删改查 / 答疑 / 概览），
 * 不负责执行任务的具体工作（执行是人的事，或将来由专门的执行角色承担）。
 *
 * 两条出站链路：
 *   飞书任务：@action/feishu-api（用户身份 user_access_token，需一次 OAuth 授权）
 *   Gitea 工单：@action/gitea-api（token 认证 + 公共 DNS 绕行，实例经验固化自
 *               ~/.agents/skills/gitea-aigility；默认仓库 GITEA_DEFAULT_REPO，
 *               默认 TiMEM-AI/timem-platform-backend）
 *
 * 意图解析采用确定性正则（零 LLM 成本、零幻觉、可单测），「任务」与「工单」
 * 触发词严格区分，工单意图先于任务意图匹配（避免「完成工单 x」被「完成 x」吞掉）：
 *   飞书：建任务：<标题> [截止 YYYY-MM-DD] | 我的任务 | 完成 <关键字>
 *   工单：建工单 @组织/仓库：<标题>（多行正文，自动查重；仓库必填，
 *         缺省不落默认仓库而是反问并列出可访问仓库）| 工单列表 [@仓库]
 *         | 查工单 [@仓库] <#n|关键字> | 关闭工单/重开工单 [@仓库] <#n|关键字>
 *         | 评论工单 [@仓库] <#n> <内容>
 *   协调：项目概览 —— 飞书待办 + 进行中工单一屏汇总
 *   其他：能力说明（帮助文本）
 */

import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
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

// ── 请求/响应 ────────────────────────────────────────────────────

export interface FeishuTaskAssistantRequest {
  /** 用户消息原文 */
  user_input: string;
  /** 用户标识（飞书 open_id） */
  user_id?: string;
  /** 会话 ID（飞书 chat_id） */
  session_id?: string;
  /** 聊天类型: p2p | group */
  chat_type?: string;
}

export interface FeishuTaskAssistantResponse {
  /** 回复文本（ingress 原地编辑到占位消息） */
  response: string;
  agent_name: string;
  session_id: string;
  trace_id: string;
}

export const feishuTaskAssistantService: ServiceDefinition<
  FeishuTaskAssistantRequest,
  FeishuTaskAssistantResponse
> = {
  id: "@persona/feishu-task-assistant",
  version: "1.1.0",
  layer: LayerId.Persona,
  description:
    "项目小助理：飞书任务 + Gitea 工单协调（正则意图 → @action/feishu-api 与 @action/gitea-api，只管理不执行）",
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

// ── 意图解析（导出供单测） ────────────────────────────────────────

export type TaskIntent =
  | { kind: "create"; title: string; dueDate?: string }
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
  | { kind: "overview" }
  | { kind: "help" };

/**
 * 提取消息内的仓库指定片段 @组织/仓库 或 @短名：
 *   - 显式：@AIGility-Cloud-Innovation/nx-telecom-video-platform
 *   - 简写：@video → 经 resolveRepoInput 在可访问仓库里模糊解析
 * 负向前瞻 (?![.\w]) 防邮箱误触：bob@example.com 的 @example 后跟点不匹配，
 * 而「建工单@video：标题」「（@video）」等紧贴场景可正常识别
 */
export function extractRepoSpec(text: string): { text: string; repo?: string } {
  const m = text.match(/\s*@([A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)?)(?![.\w@])/);
  if (!m) return { text };
  return { text: text.replace(m[0], " ").replace(/\s{2,}/g, " ").trim(), repo: m[1] };
}

/**
 * 把用户输入的仓库片段解析为 full_name：
 *   - 含 / ：直接当作 组织/仓库 使用
 *   - 不含 / ：当作仓库短名/别名，先精确匹配仓库名，再唯一子串匹配
 *     （@video → nx-telecom-video-platform）；0 个或多个命中返回
 *     undefined（建工单走反问澄清，查询类回落默认仓库）
 */
export async function resolveRepoInput(
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

/** token 可访问的活跃仓库（按最近更新排序，供反问提示与短名解析） */
export async function candidateRepos(ctx: SeamContext): Promise<string[]> {
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

const DUE_RE = /\s*截止[:：]?\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** 工单意图解析（文本已剥离 @仓库 片段与触发词，仓库必填性在此分派） */
function issueIntentFrom(
  kind: "issue-list" | "issue-show" | "issue-close" | "issue-reopen" | "issue-comment",
  rest: { repo?: string; ref?: string; comment?: string },
): TaskIntent {
  switch (kind) {
    case "issue-list":
      return { kind, repo: rest.repo };
    case "issue-show":
    case "issue-close":
    case "issue-reopen":
      return { kind, repo: rest.repo, ref: rest.ref ?? "" };
    case "issue-comment":
      return { kind, repo: rest.repo, ref: rest.ref ?? "", comment: rest.comment ?? "" };
  }
}

/** 把用户消息解析为协调意图（工单意图先于任务意图，触发词含「工单」优先） */
export function parseTaskIntent(input: string): TaskIntent {
  const text = input.trim();

  // ── 协调：项目概览 ──
  if (/^(?:项目概览|项目状态|整体概览|概览)$/.test(text)) {
    return { kind: "overview" };
  }

  // ── Gitea 工单（先剥离 @仓库 片段再匹配触发词） ──
  const stripped = extractRepoSpec(text);
  const repoSpec = stripped.repo;
  const body = stripped.text;

  if (/^(?:工单列表|我的工单|列出工单|看看工单|查工单列表)$/.test(body)) {
    return issueIntentFrom("issue-list", { repo: repoSpec });
  }

  let m = body.match(/^(?:评论工单|回复工单)\s*[:：]?\s*#?(\d+)\s*[:：,，]?\s*([\s\S]+)$/);
  if (m) {
    return issueIntentFrom("issue-comment", {
      repo: repoSpec,
      ref: m[1],
      comment: m[2].trim(),
    });
  }

  m = body.match(/^(?:查工单|看工单|工单详情)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-show", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:关闭工单|完结工单|完成工单|关掉工单|关单)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-close", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:重开工单|重新打开工单)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-reopen", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:建工单|创建工单|新建工单|开个工单)[:：，,]?\s*([\s\S]+)$/);
  if (m) {
    // 首行为标题，其余行作为正文
    const lines = m[1].split(/\r?\n/);
    const title = lines[0].trim().replace(/^[:：，,]\s*/, "");
    const issueBody = lines.slice(1).join("\n").trim();
    if (title) {
      // 仓库必填：没带 @仓库 就反问（不静默落默认仓库）
      return repoSpec
        ? { kind: "issue-create", repo: repoSpec, title, body: issueBody || undefined }
        : { kind: "issue-need-repo", title, body: issueBody || undefined };
    }
  }

  // ── 飞书任务 ──
  m = text.match(/^(?:建任务|创建任务|新建任务|添加任务)[:：，,]?\s*(.+)$/);
  if (m) {
    let title = m[1].trim().replace(/^[:：，,]\s*/, "");
    let dueDate: string | undefined;
    const due = title.match(DUE_RE);
    if (due) {
      dueDate = due[1];
      title = title.slice(0, due.index).trim();
    }
    if (title) return { kind: "create", title, dueDate };
  }

  if (/^(我的任务|任务列表|列出任务|查任务|看看任务)/.test(text)) {
    return { kind: "list" };
  }

  m = text.match(/^(?:完成任务|完成了|做完|完结|完成)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return { kind: "complete", keyword: m[1].trim() };
  }

  return { kind: "help" };
}

// ── 文本格式化（导出供单测） ──────────────────────────────────────

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

// ── Provider 实现 ────────────────────────────────────────────────

const AGENT_NAME = "项目小助理";

const HELP_TEXT = `我是「项目小助理」，负责协调你的飞书任务和 Gitea 工单（git.aigility.cloud；只管理，不执行具体工作）。

📋 飞书任务
• 建任务：<标题>（可加"截止 YYYY-MM-DD"）
• 我的任务 —— 查看待办任务
• 完成 <关键字> —— 完结匹配的任务

🎫 Gitea 工单（建工单必须 @仓库：@组织/仓库 或 @仓库短名，如 @video）
• 建工单 @仓库：<标题> —— 创建（可多行，首行为标题其余为正文；自动查重）
• 工单列表 [@仓库] / 查工单 [@仓库] <#编号或关键字> —— 查询
• 关闭工单 [@仓库] <#编号或关键字> / 重开工单 [@仓库] <#编号>
• 评论工单 [@仓库] <#编号> <内容>

📊 项目概览 —— 飞书待办 + 进行中工单一屏汇总

例：「建任务：周五交周报 截止 2026-10-16」「建工单 @video：修复登录页白屏」`;

/** 通过 ctx.call 调行动层飞书 API 的轻量封装 */
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

/** 通过 ctx.call 调行动层 Gitea API 的轻量封装 */
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
 * 未指定回落 GITEA_DEFAULT_REPO（查询类意图的兜底；建工单不走兜底——
 * 仓库必填，缺省在解析层即转 issue-need-repo 反问）
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

/** 仓库必填的反问：不发任何写请求，实时拉取可访问仓库做候选 */
async function askForRepo(ctx: SeamContext, title: string): Promise<string> {
  const repos = await candidateRepos(ctx);
  const list = repos.length
    ? repos.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "（暂无法获取仓库列表，请直接用 @组织/仓库 全名重发）";
  return [
    `请指定工单仓库（建工单必须 @仓库），把命令重发一遍带上即可：`,
    `「建工单 @组织/仓库：${title}」`,
    ``,
    `最近活跃的可访问仓库：`,
    list,
  ].join("\n");
}

/** 工单意图处理（增删改查 + 评论）；repo=意图显式 @仓库（短名在此解析为 full_name） */
async function handleIssueIntent(
  intent: Extract<TaskIntent, { kind: `issue-${string}` }>,
  ctx: SeamContext,
): Promise<string> {
  const rawRepo = "repo" in intent ? intent.repo : undefined;
  const repo = rawRepo ? await resolveRepoInput(ctx, rawRepo) : undefined;

  if (intent.kind === "issue-need-repo") {
    return askForRepo(ctx, intent.title);
  }

  if (intent.kind === "issue-create") {
    // 短名解析失败（0 或多个命中）同样反问，不猜仓库
    if (!repo) return askForRepo(ctx, intent.title);
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
    return `✅ 已建工单 ${giteaRepo(repo)} #${created?.number}：${created?.title ?? intent.title}${
      intent.body ? "（含正文）" : ""
    }\n${created?.html_url ?? ""}`.trimEnd();
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

/** 飞书任务意图处理（原有能力，保持不变） */
async function handleTaskIntent(
  intent: Extract<TaskIntent, { kind: "create" | "list" | "complete" }>,
  ctx: SeamContext,
): Promise<string> {
  if (intent.kind === "create") {
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
    return `✅ 已创建任务：${t?.summary ?? intent.title}${intent.dueDate ? `（截止 ${intent.dueDate}）` : ""}`;
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

/** 工单意图类型守卫（模板字面量收窄，供 execute 分派） */
function isIssueIntent(
  i: TaskIntent,
): i is Extract<TaskIntent, { kind: `issue-${string}` }> {
  return i.kind.startsWith("issue-");
}

export const feishuTaskAssistantProvider: Provider<
  FeishuTaskAssistantRequest,
  FeishuTaskAssistantResponse
> = {
  service: feishuTaskAssistantService,
  name: "persona-feishu-task-assistant",
  state: PluginState.Active,

  async execute(
    request: FeishuTaskAssistantRequest,
    ctx: SeamContext,
  ): Promise<Result<FeishuTaskAssistantResponse>> {
    const intent = parseTaskIntent(request.user_input ?? "");
    let response: string;

    if (intent.kind === "help") {
      response = HELP_TEXT;
    } else if (intent.kind === "overview") {
      response = await buildOverview(ctx);
    } else if (isIssueIntent(intent)) {
      response = await handleIssueIntent(intent, ctx);
    } else {
      response = await handleTaskIntent(intent, ctx);
    }

    return ok({
      response,
      agent_name: AGENT_NAME,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },

  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "feishu-task-assistant ready（正则意图 → @action/feishu-api + @action/gitea-api）",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/feishu-task-assistant",
  layer: LayerId.Persona,
  description:
    "角色人格层：「项目小助理」协调飞书任务与 Gitea 工单增删改查（只管理，不执行具体工作）",
  version: "1.1.0",
  provides: [feishuTaskAssistantService],
  consumes: [feishuApiRef, giteaApiRef],
  preferredCarrier: CarrierKind.Thread,
};
