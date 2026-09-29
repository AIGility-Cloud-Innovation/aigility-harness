/**
 * L4 编排层: task-issue-sync —「项目小助理」业务域服务 + 工单/任务双建同步
 *                        + 状态队列（P/D/C/A）+ 派发执行域（2026-09-26 定稿）
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
 * 执行闭环（2026-09-26 定稿，飞书自定义分组=状态主源）：
 *   P 计划中（plan-gate：去重+LLM 目标核对 → 完备自动挪 D；
 *             不完备 needs-input + 群提问；手动挪 D = 跳核对强授权）
 *   D 执行中（dispatch-scan 每 10min：agentd 去重 → create-from-message
 *             → confirm-prompt delayMs=15min 确认闸门 → 群通知可取消；
 *             「确认派发 #N」= run 提前执行；「取消 #N」= DELETE 任务）
 *   C 待测试（终态 completed → 工单评论产出 → 自动关单 → 任务挪 C）
 *   A 待修复（终态 failed/blocked/cancelled → 工单评论原因 → 任务挪 A）
 *
 * 只管理，不执行代码：本服务派发任务给 agentd（timem-project，代码零改动），
 * 写代码由 agentd 内的 codex 系工人完成。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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
// 复用 pipeline 的判定/去重纯函数与 LLM 引用（单一真相，不复制实现）
import {
  addPendingCandidate,
  chatRepoMapFromEnv,
  dropPendingCandidate,
  jaccard,
  llmInferenceRef,
  mappedChatPool,
  peekPendingCandidate,
  takePendingCandidate,
} from "./task-pipeline.js";

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
  | { kind: "create"; title: string; dueDate?: string; repo?: string; description?: string }
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
  /** 派发确认：「确认派发 #N」（提前执行已过 15min 闸门的任务） */
  | { kind: "dispatch-confirm"; ref: string }
  /** 派发取消：「取消派发 #N」（撤销 agentd 任务 + 工单退回 P） */
  | { kind: "dispatch-cancel"; ref: string }
  /** 安排执行者：「安排执行者 #N @张三」→ 任务描述记执行者 + 工单评论；
   *  P→D 闸门要求：有执行者的任务才会被 plan-gate 自动流转到 D */
  | { kind: "assign"; ref: string; executor: string }
  /** 澄清归属确认：「任务归属 N @仓库」——把群内澄清队列的候选建成工单
   *  （来源群候选池判不动时进队列，群里回复本指令落单；只能在该群内认领） */
  | { kind: "pending-assign"; ref: string; repo: string }
  /** 澄清归属放弃：「跳过任务 N」——丢弃澄清队列候选，不建单 */
  | { kind: "pending-skip"; ref: string }
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
      /** 任务信息来源群 chatId（写入任务描述，plan-gate 提问/汇总可回溯） */
      sourceChatId?: string;
    }
  | {
      /** 定时扫描模式：装配层接飞书 ingress 后周期调用（plan-gate + dispatch-scan + 终态回写） */
      mode: "scan";
      /** org 任务清单 guid（分组挂其下；与 tasklistName 二选一，guid 优先） */
      tasklistGuid?: string;
      /** org 任务清单名（如 TiMEM-AI；内部解析为 guid） */
      tasklistName?: string;
      /** 多清单扫描：任务归属跨组织时按 org 逐清单跑闸门（优先于 tasklistName/tasklistGuid） */
      tasklistNames?: string[];
      /** 群通知目标会话；未设则只返回报告不播报 */
      notifyChatId?: string;
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
  version: "1.1.0",
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

/** 仓库必填的反问（工单/任务共用）：不发任何写请求。
 *  pool=来源群候选池：只列池内仓库（本群归属参考）；未传/为空时维持原行为拉全量活跃仓库 */
async function askForRepo(ctx: SeamContext, verb: string, title: string, pool?: string[]): Promise<string> {
  const list = pool && pool.length > 0
    ? pool.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join("\n")
    : await candidateRepos(ctx).then((repos) =>
        repos.length
          ? repos.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join("\n")
          : "（暂无法获取仓库列表，请直接用 @组织/仓库 全名重发）",
      );
  const listTitle = pool && pool.length > 0 ? "本群可归属的候选仓库：" : "最近活跃的可访问仓库：";
  return [
    `请指定仓库（${verb}必须 @仓库，双向同步建单），把命令重发一遍带上即可：`,
    `「${verb} @组织/仓库：${title}」`,
    ``,
    listTitle,
    list,
  ].join("\n");
}

/**
 * 来源群归属默认值（主动指令路径，与被动判定共用 TASK_CHAT_REPO_MAP）：
 *   - 群已映射且池内单仓 → auto=该仓库（确定性归属，回执注明"按本群归属"）
 *   - 群已映射且池内多仓 → pool=候选池（反问只列池内，不再全网拉仓库）
 *   - 未映射/池展开失败 → 空对象（维持原行为）
 */
async function groupRepoDefault(
  ctx: SeamContext,
  sessionChatId: string | undefined,
): Promise<{ auto?: string; pool?: string[] }> {
  if (!sessionChatId) return {};
  const pool = await mappedChatPool(ctx, chatRepoMapFromEnv(), sessionChatId);
  if (!pool || pool.length === 0) return {};
  if (pool.length === 1) return { auto: pool[0] };
  return { pool };
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
  sourceChatId?: string,
): Promise<{ ok: boolean; detail: string }> {
  const listName = tasklistNameForRepo(repo);
  const list = await ensureTasklist(ctx, listName);
  if (list.error || !list.guid) {
    return { ok: false, detail: `清单「${listName}」不可用：${list.error}` };
  }
  const body: Record<string, unknown> = { summary: syncTaskSummary(repo, issue) };
  const descParts: string[] = [];
  if (issue.html_url) descParts.push(`工单链接：${issue.html_url}`);
  if (sourceChatId) descParts.push(`来源群：${sourceChatId}`);
  if (descParts.length > 0) body.description = descParts.join("\n");
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

// ── 状态队列（飞书自定义分组 P/D/C/A = 状态主源；SDK 源码考证端点） ──

/** 四状态分组名（清单内自定义分组；缺则自动创建） */
export const SECTION_NAMES = { plan: "P 计划中", doing: "D 执行中", check: "C 待测试", fix: "A 待修复" } as const;
export type SectionKey = keyof typeof SECTION_NAMES;

interface SectionLike {
  guid?: string;
  name?: string;
}

/** 进程内 清单guid → {分组名→section guid} 缓存 */
const sectionGuidCache = new Map<string, Partial<Record<SectionKey, string>>>();

/** 列清单下的自定义分组（GET /sections?resource_type=tasklist&resource_id=…） */
async function listSections(ctx: SeamContext, tasklistGuid: string): Promise<SectionLike[]> {
  const r = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/sections",
    query: { resource_type: "tasklist", resource_id: tasklistGuid, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) return [];
  return (r.value?.data as { items?: SectionLike[] })?.items ?? [];
}

/** 创建自定义分组（POST /sections，resource_type=tasklist） */
async function createSection(ctx: SeamContext, tasklistGuid: string, name: string): Promise<string | undefined> {
  const r = await callFeishuApi(ctx, {
    method: "POST",
    path: "/open-apis/task/v2/sections",
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { name, resource_type: "tasklist", resource_id: tasklistGuid },
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) {
    console.error(`[task-issue-sync] 建分组「${name}」失败: ${r.ok ? r.value?.msg : r.error}`);
    return undefined;
  }
  return (r.value?.data as { section?: SectionLike })?.section?.guid;
}

/** 确保四分组存在，返回 分组名→guid（缺自动建；单组建失败置 undefined 不阻塞其余） */
export async function ensureSections(
  ctx: SeamContext,
  tasklistGuid: string,
): Promise<Partial<Record<SectionKey, string>>> {
  const cached = sectionGuidCache.get(tasklistGuid);
  if (cached && (Object.keys(cached).length as number) === Object.keys(SECTION_NAMES).length) return cached;
  const existing = await listSections(ctx, tasklistGuid);
  const map: Partial<Record<SectionKey, string>> = {};
  for (const [key, name] of Object.entries(SECTION_NAMES) as [SectionKey, string][]) {
    map[key] = existing.find((s) => (s.name ?? "").trim() === name)?.guid
      ?? (await createSection(ctx, tasklistGuid, name));
  }
  if (Object.values(map).every(Boolean)) sectionGuidCache.set(tasklistGuid, map);
  return map;
}

/** 任务挪进某分组（add_tasklist 带 section_guid；同组幂等返回成功） */
export async function moveToSection(
  ctx: SeamContext,
  taskGuid: string,
  tasklistGuid: string,
  sectionGuid: string,
): Promise<boolean> {
  const r = await callFeishuApi(ctx, {
    method: "POST",
    path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { tasklist_guid: tasklistGuid, section_guid: sectionGuid },
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) {
    console.error(`[task-issue-sync] 挪任务进分组失败: ${r.ok ? r.value?.msg : r.error}`);
    return false;
  }
  return true;
}

/** 列某分组内的任务（GET /sections/:guid/tasks，completed=false 只取未完成） */
async function listSectionTasks(
  ctx: SeamContext,
  sectionGuid: string,
): Promise<Array<{ guid?: string; task_id?: string; summary?: string; description?: string }>> {
  const r = await callFeishuApi(ctx, {
    method: "GET",
    path: `/open-apis/task/v2/sections/${sectionGuid}/tasks`,
    query: { completed: false, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) return [];
  return (r.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string }> })?.items ?? [];
}

/** 双建任务标题 [org/repo#N] 标题 → 工单号（解析不出返回 undefined） */
export function issueNumberFromTaskSummary(summary: string | undefined): number | undefined {
  const m = (summary ?? "").match(/\[([^\]#/]+)\/([^\]#]+)#(\d+)\]/);
  return m ? Number(m[3]) : undefined;
}

// ── 派发执行域（agentd UDS 客户端复用 agentd-client；delayMs 闸门在 agentd 侧） ──

import {
  type AgentdEndpoint,
  type AgentdTask,
  cancelTask as agentdCancel,
  confirmProject as agentdConfirmProject,
  confirmPrompt as agentdConfirmPrompt,
  createFromMessage as agentdCreateFromMessage,
  defaultSocketPath,
  defaultToken,
  listProjects as agentdListProjects,
  listTasks as agentdListTasks,
  registerProject as agentdRegisterProject,
  runTask as agentdRunTask,
  CANCELABLE_STATUSES,
} from "./agentd-client.js";

/** 派发域配置（env 可覆盖） */
export function dispatchDelayMs(): number {
  const env = Number(process.env["TIMEM_DISPATCH_CONFIRM_MS"]);
  return Number.isFinite(env) && env >= 0 ? env : 15 * 60_000; // 15 分钟确认闸门
}

function dispatchEndpoint(): AgentdEndpoint {
  return { socketPath: defaultSocketPath(), token: defaultToken() };
}

/** agentd 活跃任务里是否已有该工单派生任务（sourceMessageId=issue:{repo}#{n} 约定） */
async function agentdHasActiveForIssue(endpoint: AgentdEndpoint, repo: string, issueNo: number): Promise<AgentdTask | undefined> {
  const tasks = await agentdListTasks(endpoint).catch(() => [] as AgentdTask[]);
  const marker = `issue:${repo}#${issueNo}`;
  return tasks.find(
    (t) =>
      (t.sourceMessageId ?? "") === marker &&
      [...CANCELABLE_STATUSES, "queued", "needs_review"].includes(t.status ?? ""),
  );
}

/** 执行提示词组装（工单标题+正文全文；agentd 内部工人自行探索代码库） */
export function buildDispatchPrompt(repo: string, issue: { number?: number; title?: string; body?: string }): string {
  return [
    `请完成 ${repo} 工单 #${issue.number ?? "?"}：${issue.title?.trim() ?? "(无标题)"}`,
    issue.body?.trim() ? `\n工单正文：\n${issue.body.trim()}` : "",
    `\n完成后按项目惯例提交（commit 信息引用工单号 #${issue.number ?? "?"}）。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 派发核心：工单 → agentd 任务（pending_confirm + delayMs 闸门）→ 回执文本 */
/** 项目自动注册：agentd 已注册则复用；未注册且本地 ~/AI/<短名> 存在则注册；否则 undefined（不自动克隆） */
async function ensureProjectRegistered(repo: string): Promise<string | undefined> {
  const shortName = repo.split("/")[1] ?? repo;
  const endpoint: AgentdEndpoint = { socketPath: defaultSocketPath(), token: defaultToken() };
  const projects = await agentdListProjects(endpoint).catch(() => [] as Array<{ id?: string; name?: string }>);
  const hit = projects.find((p) => p.id === shortName || p.name === shortName);
  if (hit?.id) return hit.id;
  const localRoot = resolve(join(homedir(), "AI", shortName));
  if (!existsSync(localRoot)) return undefined;
  const reg = await agentdRegisterProject(endpoint, {
    id: shortName,
    name: shortName,
    rootPaths: [localRoot],
    available: true,
  }).catch((e: Error) => e);
  if (reg instanceof Error || !reg.id) return undefined;
  return reg.id ?? shortName;
}

async function dispatchIssue(
  ctx: SeamContext,
  repo: string,
  issue: IssueLike & { body?: string },
  notifyChatId?: string,
): Promise<string> {
  const issueNo = issue.number;
  if (!issueNo) return "❌ 派发失败：工单缺少编号";
  const endpoint = dispatchEndpoint();

  // ① agentd 去重：同工单已有活跃任务则不重复派发
  const active = await agentdHasActiveForIssue(endpoint, repo, issueNo);
  if (active) {
    return `⏭️ 工单 #${issueNo} 已有进行中的执行任务（${active.status}），不重复派发。`;
  }

  // ② 建任务：sourceMessageId=issue:{repo}#{n}（确定性映射，零存储防重）
  const prompt = buildDispatchPrompt(repo, issue);
  const created = await agentdCreateFromMessage(endpoint, {
    source: "harness-dispatch",
    sourceMessageId: `issue:${repo}#${issueNo}`,
    sourceConversationId: notifyChatId ?? "",
    title: `#${issueNo} ${issue.title?.trim() ?? ""}`.slice(0, 80),
    description: prompt,
    text: prompt,
  });
  const taskId = created.id ?? created.taskId ?? "";
  if (!taskId) return "❌ 派发失败：agentd 未返回任务 ID（执行引擎未就绪或参数被拒）";

  // ③ 项目归属闸门：identify 已解析则自动确认（高置信建单即带 projectId）
  let status = created.status ?? "";
  if (created.pending_project || status === "pending_project") {
    const projectId = await ensureProjectRegistered(repo);
    if (!projectId) {
      return `⚠️ 工单 #${issueNo} 的执行任务待确认项目归属（agentd 任务 ${taskId}）。本地无 ~/AI/${repo.split("/")[1] ?? repo} 目录且 agentd 未注册该项目，请先克隆或手工注册。`;
    }
    const confirmedP = await agentdConfirmProject(endpoint, taskId, projectId).catch((e: Error) => e);
    if (confirmedP instanceof Error) {
      return `⚠️ 工单 #${issueNo} 项目归属确认失败（${confirmedP.message}），agentd 任务 ${taskId}`;
    }
    status = confirmedP.status ?? "pending_confirm";
  }

  // ④ 确认闸门：pending_confirm → queued + delayMs 定时（agentd scheduleLoop 自动跑）
  if (status === "pending_confirm") {
    const confirmed = await agentdConfirmPrompt(endpoint, taskId, { delayMs: dispatchDelayMs() });
    status = confirmed.status ?? "queued";
  }

  const mins = Math.round(dispatchDelayMs() / 60_000);
  return [
    `⚙️ 已取走工单 #${issueNo}，安排 code agent 执行：`,
    `${issue.title?.trim() ?? ""}`,
    `· 确认闸门：${mins} 分钟内回复「取消派发 #${issueNo}」可撤销，超时自动执行`,
    `· 回复「确认派发 #${issueNo}」立即执行`,
    status === "queued" ? `· agentd 任务：${taskId}` : `· agentd 任务：${taskId}（状态 ${status}）`,
  ].join("\n");
}

/** 终态回写：工单评论(+成功自动关单) + 飞书任务挪 C/A；返回给群的通知文本 */
async function writebackOnFinal(
  ctx: SeamContext,
  repo: string,
  issueNo: number,
  taskId: string,
  status: string,
  tasklistGuid: string,
  sections: Partial<Record<SectionKey, string>>,
  feishuTaskGuid?: string,
): Promise<string> {
  const endpoint = dispatchEndpoint();
  const task = await agentdListTasks(endpoint)
    .then((all) => all.find((t) => t.id === taskId))
    .catch(() => undefined);
  const okRun = status === "completed" || status === "needs_review";

  // 工单评论：成功=完成通告+自动关单；失败=原因留单
  const comment = okRun
    ? `🤖 code agent 已完成本工单（agentd 任务 ${taskId}，状态 ${status}），请测试验收。`
    : `🤖 code agent 执行未成功（agentd 任务 ${taskId}，状态 ${status}）${task?.lastError ? `：${task.lastError}` : ""}。工单保留，可修复后重新派发。`;
  await callGiteaApi(ctx, {
    method: "POST",
    path: `${issuesBaseFor(repo)}/${issueNo}/comments`,
    body: { body: comment },
  }).catch(() => undefined);
  if (okRun) {
    await callGiteaApi(ctx, {
      method: "PATCH",
      path: `${issuesBaseFor(repo)}/${issueNo}`,
      body: { state: "closed" },
    }).catch(() => undefined);
  }

  // 飞书任务挪 C/A
  const targetKey: SectionKey = okRun ? "check" : "fix";
  const sectionGuid = sections[targetKey];
  let moved = false;
  if (sectionGuid) {
    // 首选：派发时注册表记住的 guid；降级：全量列表按标题反查（分页可能漏，不可靠）
    let guid = feishuTaskGuid;
    if (!guid) {
      const fr = await callFeishuApi(ctx, {
        method: "GET",
        path: "/open-apis/task/v2/tasks",
        query: { page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }).catch(() => undefined);
      const items = (fr?.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string }> })?.items ?? [];
      const target = items.find((t) => issueNumberFromTaskSummary(t.summary) === issueNo);
      guid = target?.guid ?? target?.task_id;
    }
    if (guid) moved = await moveToSection(ctx, guid, tasklistGuid, sectionGuid);
  }

  return okRun
    ? `✅ 工单 #${issueNo} 执行完成${moved ? `，任务已挪「${SECTION_NAMES.check}」` : ""}；工单已评论并自动关闭，请测试验收。`
    : `❌ 工单 #${issueNo} 执行未成功（${status}）${moved ? `，任务已挪「${SECTION_NAMES.fix}」` : ""}；原因已评论到工单。`;
}

// ── 定时扫描域（plan-gate 扫 P + dispatch-scan 扫 D；与 pipeline 同节奏） ──

interface DispatchRuntime {
  timer: ReturnType<typeof setInterval> | null;
  /** agentd taskId → {repo, issueNo, tasklistGuid, feishuTaskGuid}（终态轮询注册表） */
  inflight: Map<string, { repo: string; issueNo: number; tasklistGuid: string; feishuTaskGuid?: string }>;
}

const dispatchRuntime: DispatchRuntime = { timer: null, inflight: new Map() };

/**
 * 收编裸任务（飞书任务为先行主源）：清单里不在 P/D/C/A 任何分组的未完成任务
 * （成员直接在清单里手工建的）→ 自动挪入「P 计划中」，进入统一闸门。
 * 返回收编数量。
 */
export async function adoptUnsectionedTasks(
  ctx: SeamContext,
  tasklistGuid: string,
): Promise<number> {
  const sections = await ensureSections(ctx, tasklistGuid);
  const sectioned = new Set<string>();
  for (const key of Object.keys(SECTION_NAMES) as SectionKey[]) {
    const guid = sections[key];
    if (!guid) continue;
    for (const t of await listSectionTasks(ctx, guid)) {
      const g = t.guid ?? t.task_id;
      if (g) sectioned.add(g);
    }
  }
  const fr = await callFeishuApi(ctx, {
    method: "GET",
    path: `/open-apis/task/v2/tasklists/${tasklistGuid}/tasks`,
    query: { completed: false, page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  if (!fr.ok || (fr.value?.code ?? -1) !== 0) return 0;
  const all = (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string }> })?.items ?? [];
  let adopted = 0;
  for (const t of all) {
    const g = t.guid ?? t.task_id;
    if (!g || sectioned.has(g)) continue;
    const planGuid = sections.plan;
    if (planGuid && (await moveToSection(ctx, g, tasklistGuid, planGuid))) adopted++;
  }
  return adopted;
}

/**
 * Gitea 收尾完成回写（工单+PR 为完成标识）：扫 P/D 分组里带 #N 的任务，
 * 工单已关闭 → 找关联的已合并 PR（title/body 提到 #N）→ 任务挪「C 待测试」+
 * 工单评论留痕。人工在 Gitea 合并 PR 收尾与 agent 执行收尾在此归一。
 */
export async function syncCompletionFromGitea(
  ctx: SeamContext,
  opts: { tasklistGuid: string; notifyChatId?: string },
): Promise<string[]> {
  const reports: string[] = [];
  const sections = await ensureSections(ctx, opts.tasklistGuid);
  // P + D 两个分组的任务都纳入完成监听（C/A 已是终态侧，不再倒查）
  const watched: Array<{ guid: string; summary: string; description?: string }> = [];
  for (const key of ["plan", "doing"] as const) {
    const guid = sections[key];
    if (!guid) continue;
    for (const t of await listSectionTasks(ctx, guid)) {
      const g = t.guid ?? t.task_id;
      if (g && t.summary) watched.push({ guid: g, summary: t.summary, description: t.description });
    }
  }

  /** 工单号 → 是否存在提到它的已合并 PR（缓存避免重复拉 PR 列表） */
  const mergedPrCache = new Map<string, string | undefined>();
  const findMergedPr = async (repo: string, issueNo: number): Promise<string | undefined> => {
    const cacheKey = `${repo}#${issueNo}`;
    if (mergedPrCache.has(cacheKey)) return mergedPrCache.get(cacheKey);
    let hit: string | undefined;
    const r = await callGiteaApi(ctx, {
      method: "GET",
      path: issuesBaseFor(repo).replace(/\/issues$/, "/pulls"),
      query: { state: "closed", limit: 30 },
    });
    if (r.ok && is2xx(r.value?.status ?? 0)) {
      for (const pr of (r.value?.data as Array<{ number?: number; title?: string; body?: string; merged?: boolean }>) ?? []) {
        if (!pr.merged) continue;
        const mentions = (pr.title ?? "").includes(`#${issueNo}`) || (pr.body ?? "").includes(`#${issueNo}`);
        if (mentions) {
          hit = `!${pr.number} ${pr.title ?? ""}`.trim();
          break;
        }
      }
    }
    mergedPrCache.set(cacheKey, hit);
    return hit;
  };

  for (const t of watched) {
    const issueNo = issueNumberFromTaskSummary(t.summary);
    if (issueNo === undefined) continue;
    const repoMatch = t.summary.match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
    const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : giteaRepo();
    const r = await callGiteaApi(ctx, {
      method: "GET",
      path: `${issuesBaseFor(repo)}/${issueNo}`,
    });
    if (!r.ok || !is2xx(r.value?.status ?? 0)) continue;
    const issue = r.value?.data as { state?: string; title?: string };
    if ((issue.state ?? "open") !== "closed") continue;

    // 工单已关闭 → 查合并 PR → 挪 C 待测试（完成的唯一收尾口）
    const mergedPr = await findMergedPr(repo, issueNo);
    const checkGuid = sections.check;
    let moved = false;
    if (checkGuid) moved = await moveToSection(ctx, t.guid, opts.tasklistGuid, checkGuid);
    await callGiteaApi(ctx, {
      method: "POST",
      path: `${issuesBaseFor(repo)}/${issueNo}/comments`,
      body: { body: `✅ 工单已关闭${mergedPr ? `，关联 PR ${mergedPr} 已合并` : ""}。飞书任务已挪「${SECTION_NAMES.check}」待测试。` },
    }).catch(() => undefined);
    const msg = `🏁 「${t.summary.replace(/^\[[^\]]+\]\s*/, "").slice(0, 40)}」对应工单 #${issueNo} 已关闭${mergedPr ? `（PR ${mergedPr} 已合并）` : ""}，任务已挪「${SECTION_NAMES.check}」待测试。`;
    reports.push(msg);
    await dispatchNotify(opts.notifyChatId, msg);
  }
  return reports;
}

/** 群通知注入（装配层 set；与 task-pipeline.setNotifySend 同款约定） */
let dispatchNotifySend: ((chatId: string, text: string) => Promise<void>) | undefined;
export function setDispatchNotifySend(fn: ((chatId: string, text: string) => Promise<void>) | undefined): void {
  dispatchNotifySend = fn;
}

async function dispatchNotify(chatId: string | undefined, text: string): Promise<void> {
  if (!chatId || !dispatchNotifySend) return;
  try {
    await dispatchNotifySend(chatId, text);
  } catch (e) {
    console.error(`[task-issue-sync] dispatch notify failed: ${String(e)}`);
  }
}

/**
 * plan-gate：加工 P 分组（去重 → LLM 目标核对 → 完备自动挪 D）。
 * 手动挪 D = 跳过核对（本函数只看 P 分组）；不完备打 needs-input 描述前缀，下轮跳过重判省 token。
 */
export async function runPlanGate(
  ctx: SeamContext,
  opts: { tasklistGuid: string; notifyChatId?: string; model?: string; threshold?: number },
): Promise<string[]> {
  const reports: string[] = [];
  const sections = await ensureSections(ctx, opts.tasklistGuid);
  const planGuid = sections.plan;
  const doingGuid = sections.doing;
  if (!planGuid || !doingGuid) return ["状态分组不可用（P/D 缺失且自动建失败）"];

  const planTasks = await listSectionTasks(ctx, planGuid);
  if (planTasks.length === 0) return reports;

  // 现有 open 工单标题（去重基准；阈值与 pipeline 一致 0.5）
  const threshold = opts.threshold ?? 0.5;
  const existingTitles: string[] = [];
  const dr = await callGiteaApi(ctx, {
    method: "GET",
    path: issuesBaseFor(),
    query: { state: "open", limit: 50, type: "issues" },
  });
  if (dr.ok && is2xx(dr.value?.status ?? 0)) {
    for (const it of (dr.value?.data as IssueLike[]) ?? []) {
      if (it.title) existingTitles.push(it.title);
    }
  }

  for (const t of planTasks) {
    const guid = t.guid ?? t.task_id ?? "";
    const summary = t.summary ?? "";
    if (!guid) continue;
    const issueNo = issueNumberFromTaskSummary(summary);

    // ① 去重：与 open 工单（排除自身对应单）Jaccard 相似
    const dupHit = existingTitles.find(
      (title) =>
        jaccard(title, summary.replace(/^\[[^\]]+\]\s*/, "")) >= threshold &&
        issueNo === undefined, // 双建任务自身必有对应工单，编号可解析则跳过工单查重
    );
    if (dupHit) {
      reports.push(`🧹 「${summary.slice(0, 40)}」与现有工单「${dupHit.slice(0, 40)}」疑似重复，已留 P 待人工确认。`);
      continue;
    }

    // ⓪-a 先行任务回填工单：人工直接建的任务没有 #N → 自动建 Gitea 工单
    // （以飞书任务为先行主源；工单+PR 是后续收尾完成的标识）
    if (issueNo === undefined && !summary.includes("【待补充】")) {
      const cleanTitle = summary.replace(/^【待安排执行者】/, "").trim();
      const repo = giteaRepo();
      const ir = await callGiteaApi(ctx, {
        method: "POST",
        path: issuesBaseFor(repo),
        body: {
          title: cleanTitle,
          body: `> 来源：飞书任务（成员直接创建，由项目小助理回填工单）\n>\n> 飞书任务：${summary.slice(0, 80)}`,
        },
      });
      if (ir.ok && is2xx(ir.value?.status ?? 0)) {
        const issue = ir.value?.data as { number?: number; html_url?: string };
        const sync = await syncIssueToTask(ctx, repo, issue);
        reports.push(
          sync.ok
            ? `🔗 「${cleanTitle.slice(0, 40)}」已回填工单 ${repo}#${issue.number}（双建完成），可「安排执行者 #${issue.number} @姓名」。`
            : `⚠️ 「${cleanTitle.slice(0, 40)}」工单 ${repo}#${issue.number} 已建但同步任务失败：${sync.detail}`,
        );
      } else {
        reports.push(`⚠️ 「${cleanTitle.slice(0, 40)}」回填工单失败，下轮重试：${ir.ok ? `HTTP ${ir.value?.status}` : ir.error}`);
      }
      continue; // 本轮先完成回填，下轮再走执行者/核对闸门
    }

    // ⓪ 执行者闸门：未安排执行者的任务不进入执行（需群里「安排执行者 #N @姓名」）
    if (!/执行者：\S+/.test(t.description ?? "")) {
      const tagged = `【待安排执行者】${summary.replace(/^【待安排执行者】/, "")}`;
      if (tagged !== summary) {
        await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
          body: { update_fields: ["summary"], task: { summary: tagged } },
        }).catch(() => undefined);
      }
      reports.push(`👤 「${summary.slice(0, 40)}」尚未安排执行者，留 P。群里回复「安排执行者 #${issueNo ?? "?"} @姓名」后自动进入执行。`);
      continue;
    }

    // needs-input 前缀 = 已提问等补充，跳过 LLM 重判（用户改描述后去掉前缀才重核）
    if (summary.includes("【待补充】")) continue;

    // ② LLM 目标核对：目标物/动作/验收线索 三要素
    const model = opts.model ?? process.env.TASK_PIPELINE_MODEL ?? "glm-4-flash";
    const llm = (await ctx.call(llmInferenceRef, {
      model,
      messages: [
        {
          role: "system",
          content:
            `你是任务验收官。判断下面这条任务描述是否具备可执行要素：目标物（对什么对象做）+ 动作（做什么）+ 验收线索（怎么算做好，可有可无但影响评分）。\n` +
            `只输出纯 JSON：{"ready": true|false, "missing": "缺什么（ready=false 时必填，一句话，面向提问）"}\n` +
            `规则：描述具体明确（有页面/接口/文件/行为指向）→ ready=true；空泛（如"修一下那个问题""优化下性能"无指向）→ ready=false。`,
        },
        { role: "user", content: summary + (t.description ? `\n${t.description.slice(0, 500)}` : "") },
      ],
      temperature: 0.2,
      max_tokens: 300,
    })) as { ok: boolean; value?: { text?: string }; error?: string };

    let ready = true;
    let missing = "";
    if (llm.ok && llm.value?.text) {
      try {
        const m = llm.value.text.match(/\{[\s\S]*\}/);
        const parsed = m ? (JSON.parse(m[0]) as { ready?: boolean; missing?: string }) : null;
        ready = parsed?.ready !== false;
        missing = String(parsed?.missing ?? "");
      } catch {
        ready = true; // 解析失败不拦任务（宁多走闸门不卡队列）
      }
    }

    if (ready) {
      // ③ 完备 → 自动挪 D（授权执行）
      const moved = await moveToSection(ctx, guid, opts.tasklistGuid, doingGuid);
      reports.push(
        moved
          ? `✅ 「${summary.slice(0, 40)}」目标核对通过，已挪入「${SECTION_NAMES.doing}」，下轮扫描派发执行。`
          : `⚠️ 「${summary.slice(0, 40)}」核对通过但挪分组失败，请手动挪入 D。`,
      );
    } else {
      // ④ 不完备 → 群提问 + 打【待补充】标记（改描述后下轮重核）
      await callFeishuApi(ctx, {
        method: "PATCH",
        path: `/open-apis/task/v2/tasks/${guid}`,
        query: { user_id_type: "open_id" },
        identity: "user",
        // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
        body: { update_fields: ["summary"], task: { summary: `【待补充】${summary.replace(/^【待补充】/, "")}` } },
      }).catch(() => undefined);
      reports.push(`❓ 「${summary.slice(0, 40)}」目标不完备：${missing || "缺少明确的执行目标"}。请直接编辑任务描述补充，补齐后自动进入执行。`);
      await dispatchNotify(opts.notifyChatId, `❓ 任务「${summary.slice(0, 40)}」需要补充信息：${missing || "描述不够具体"}\n请编辑飞书任务描述，补齐后我会自动继续。`);
    }
  }
  return reports;
}

/** 自动派发开关：env TASK_AUTO_DISPATCH 显式为 0/false/off 时关闭 agent 自动执行；
 *  P→D 目标核对与终态回写不受影响，只是 D 分组任务不再派发给 agentd。 */
export function autoDispatchEnabled(): boolean {
  const v = (process.env["TASK_AUTO_DISPATCH"] ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/**
 * dispatch-scan + 终态回写：扫 D 分组派发，并轮询 inflight 任务终态做回写。
 */
export async function runDispatchScan(
  ctx: SeamContext,
  opts: { tasklistGuid: string; notifyChatId?: string },
): Promise<string[]> {
  const reports: string[] = [];
  const sections = await ensureSections(ctx, opts.tasklistGuid);
  const doingGuid = sections.doing;
  if (!doingGuid) return ["状态分组不可用（D 缺失且自动建失败）"];

  // ① inflight 终态轮询（上轮派发的任务）
  const endpoint = dispatchEndpoint();
  for (const [taskId, meta] of dispatchRuntime.inflight) {
    const current = await import("./agentd-client.js")
      .then((m) => m.getTask(endpoint, taskId))
      .catch(() => undefined);
    if (!current) continue;
    if (["completed", "needs_review", "failed", "cancelled", "blocked"].includes(current.status ?? "")) {
      dispatchRuntime.inflight.delete(taskId);
      const msg = await writebackOnFinal(ctx, meta.repo, meta.issueNo, taskId, current.status ?? "", meta.tasklistGuid, sections, meta.feishuTaskGuid);
      reports.push(msg);
      await dispatchNotify(opts.notifyChatId, msg);
    }
  }

  // ② 扫 D 分组 → 派发（TASK_AUTO_DISPATCH=0 时跳过：不自动执行，仅维持状态队列与回写）
  if (!autoDispatchEnabled()) return reports;
  const doingTasks = await listSectionTasks(ctx, doingGuid);
  for (const t of doingTasks) {
    const summary = t.summary ?? "";
    const issueNo = issueNumberFromTaskSummary(summary);
    if (issueNo === undefined) continue; // 非双建任务不自动派发（人工在工单侧补建后重挪）
    const repoFromTitle = summary.match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
    const repo = repoFromTitle ? `${repoFromTitle[1]}/${repoFromTitle[2]}` : giteaRepo();
    if (dispatchRuntime.inflight.size >= 3) {
      reports.push(`⏳ 并发上限（3），工单 #${issueNo} 留 D 下轮派发。`);
      continue;
    }
    // 工单详情（正文组装提示词）
    const r = await callGiteaApi(ctx, { method: "GET", path: `${issuesBaseFor(repo)}/${issueNo}` });
    if (!r.ok || !is2xx(r.value?.status ?? 0)) {
      reports.push(`⚠️ 工单 #${issueNo} 读取失败，留 D 下轮重试。`);
      continue;
    }
    const issue = r.value?.data as IssueLike & { body?: string };
    if ((issue.state ?? "open") !== "open") {
      reports.push(`⏭️ 工单 #${issueNo} 已关闭，跳过派发（请把任务挪出 D）。`);
      continue;
    }
    const msg = await dispatchIssue(ctx, repo, issue, opts.notifyChatId);
    reports.push(msg);
    await dispatchNotify(opts.notifyChatId, msg);
    // 派发成功（回执含 agentd 任务 id）→ 注册 inflight 轮询
    const created = msg.match(/agentd 任务：(\S+)/);
    if (created) {
      dispatchRuntime.inflight.set(created[1], {
        repo,
        issueNo,
        tasklistGuid: opts.tasklistGuid,
        feishuTaskGuid: t.guid ?? t.task_id,
      });
    }
  }
  return reports;
}

/** 停止定时扫描（装配层重启用） */
export function stopDispatchScan(): void {
  if (dispatchRuntime.timer) clearInterval(dispatchRuntime.timer);
  dispatchRuntime.timer = null;
}

// ── 派发确认/取消意图处理 ────────────────────────────────────────

/** 双建任务标题 [org/repo#N] 反查工单所属仓库（确认/取消派发用；查不到回落默认仓库）。
 *  此前硬编码 giteaRepo() 默认仓库，非默认仓库的工单永远确认/取消不到——多归属修复 */
export async function resolveRepoByIssueNo(ctx: SeamContext, issueNo: number): Promise<string | undefined> {
  const fr = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/tasks",
    query: { page_size: 50, user_id_type: "open_id" },
    identity: "user",
  }).catch(() => undefined);
  const items = (fr?.value?.data as { items?: Array<{ summary?: string }> })?.items ?? [];
  for (const t of items) {
    if (issueNumberFromTaskSummary(t.summary) !== issueNo) continue;
    const m = (t.summary ?? "").match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return undefined;
}

/** 「确认派发 #N」：inflight 或 D 分组的 agentd 任务 → run 提前执行 */
async function handleDispatchConfirm(ctx: SeamContext, ref: string): Promise<string> {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (!num) return "用法：确认派发 #工单号";
  const issueNo = Number(num[1]);
  const endpoint = dispatchEndpoint();
  const marker = `issue:${(await resolveRepoByIssueNo(ctx, issueNo)) ?? giteaRepo()}#${issueNo}`;
  const tasks = await agentdListTasks(endpoint).catch(() => [] as AgentdTask[]);
  const target = tasks.find(
    (t) => (t.sourceMessageId ?? "") === marker && ["pending_confirm", "queued"].includes(t.status ?? ""),
  );
  if (!target?.id) return `没有找到工单 #${issueNo} 的待确认派发任务。`;
  const run = await agentdRunTask(endpoint, target.id).catch((e: Error) => e);
  if (run instanceof Error) return `❌ 立即执行失败：${run.message}`;
  return `🚀 工单 #${issueNo} 已立即安排执行（跳过剩余等待时间）。完成后我会汇报并回写工单。`;
}

/** 「取消派发 #N」：撤销 agentd 任务（工单留 open，任务挪回 P） */
async function handleDispatchCancel(ctx: SeamContext, ref: string): Promise<string> {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (!num) return "用法：取消派发 #工单号";
  const issueNo = Number(num[1]);
  const endpoint = dispatchEndpoint();
  const marker = `issue:${(await resolveRepoByIssueNo(ctx, issueNo)) ?? giteaRepo()}#${issueNo}`;
  const tasks = await agentdListTasks(endpoint).catch(() => [] as AgentdTask[]);
  const target = tasks.find(
    (t) => (t.sourceMessageId ?? "") === marker && CANCELABLE_STATUSES.includes(t.status ?? ""),
  );
  if (!target?.id) return `没有找到工单 #${issueNo} 的可取消任务。`;
  await agentdCancel(endpoint, target.id);
  dispatchRuntime.inflight.delete(target.id);
  return `🛑 已取消工单 #${issueNo} 的执行任务。工单保持打开，可补充描述后重新挪入 D 再派发。`;
}

// ── 澄清归属处理（任务归属 N @仓库 / 跳过任务 N） ────────────────
// 多候选池判不动的候选停在澄清队列（task-pipeline push，群播报编号），
// 只能在识别它的群里认领（takePendingCandidate 校验 chatId，防跨群误领）。

/** 「任务归属 N @仓库」：澄清候选 → 建工单（与自动汇总同款查重/双建，来源群=本群） */
async function handlePendingAssign(
  ctx: SeamContext,
  ref: string,
  repoInput: string,
  sessionChatId?: string,
): Promise<string> {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (!num) return "用法：任务归属 编号 @仓库";
  const no = Number(num[1]);
  if (!sessionChatId) return "❌ 需要在识别到该任务的群里回复（私聊缺少群上下文）。";
  const item = peekPendingCandidate(sessionChatId, no);
  if (!item) return `没有找到本群待归属任务 #${no}（可能已处理、已跳过或已过期）。`;
  const repo = await resolveRepoInput(ctx, repoInput);
  if (!repo) {
    // 解析失败保留队列项可重试；给出全名示例
    const repos = await candidateRepos(ctx);
    return `❌ 仓库「${repoInput}」解析失败，请用 @组织/仓库 全名重试，如：任务归属 ${no} @${repos[0] ?? "组织/仓库"}`;
  }
  takePendingCandidate(sessionChatId, no); // 仓库解析成功才消费

  // 建单前查重（与 issue-create 同款；撞名则只清队列不重复建）
  const dup = await findIssue(ctx, repo, item.title);
  if (dup.error) return `❌ 建单前查重失败：${dup.error}`;
  if (dup.issue) {
    return `已有同名工单，不重复创建：\n${formatIssueDetail(dup.issue)}\n（待归属任务 #${no} 已清掉）`;
  }
  const r = await callGiteaApi(ctx, {
    method: "POST",
    path: issuesBaseFor(repo),
    body: {
      title: `[${item.priority}] ${item.title}`,
      body: `> 来源：飞书群聊自动汇总（${item.collectedAt}，群内澄清归属）\n>\n> 判定依据：${item.reason ?? "LLM 判定为待执行任务"}\n> 来源群：${sessionChatId}\n\n由 @orchestration/task-pipeline 自动创建，请负责人认领。`,
    },
  });
  if (!r.ok || !is2xx(r.value?.status ?? 0)) {
    return `❌ 建工单失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
  }
  const created = r.value?.data as IssueLike;
  const sync = await syncIssueToTask(ctx, repo, created ?? { title: item.title }, sessionChatId);
  return [
    `✅ 已建工单 ${repo} #${created?.number}：${item.title}`,
    created?.html_url ?? "",
    sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`,
    `请回复「安排执行者 #${created?.number ?? "?"} @姓名」指定执行者。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 「跳过任务 N」：丢弃澄清候选，不建单 */
function handlePendingSkip(ref: string, sessionChatId?: string): string {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (!num) return "用法：跳过任务 编号";
  if (!sessionChatId) return "❌ 需要在识别到该任务的群里回复（私聊缺少群上下文）。";
  const dropped = dropPendingCandidate(sessionChatId, Number(num[1]));
  return dropped
    ? `🚮 已丢弃待归属任务 #${num[1]}，不会建单。`
    : `没有找到本群待归属任务 #${num[1]}。`;
}

/**
 * 安排执行者：「安排执行者 #N @张三」。
 * 双写：飞书任务描述追加「执行者：X」（P→D 闸门的判定依据）+
 * Gitea 工单评论留痕。任务在哪个清单由工单号归属的 org 决定（与双建一致）。
 */
async function handleAssignExecutor(ctx: SeamContext, ref: string, executor: string): Promise<string> {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (!num) return "用法：安排执行者 #工单号 @执行者姓名";
  const issueNo = Number(num[1]);
  const name = executor.replace(/^@/, "").trim();
  if (!name) return "❌ 请带上执行者姓名，如：安排执行者 #12 @张三";

  // 全量任务列表按 [repo#N] 反查目标任务（含其所在清单信息）
  const fr = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/tasks",
    query: { page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  if (!fr.ok || (fr.value?.code ?? -1) !== 0) {
    return `❌ 任务查询失败：${fr.ok ? fr.value?.msg : fr.error}`;
  }
  const items = (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string }> })?.items ?? [];
  const target = items.find((t) => issueNumberFromTaskSummary(t.summary ?? "") === issueNo);
  if (!target?.guid && !target?.task_id) {
    return `没有找到工单 #${issueNo} 对应的飞书任务（可能尚未双建）。`;
  }
  const guid = (target.guid ?? target.task_id) as string;
  const marker = `执行者：${name}`;
  if ((target.description ?? "").includes(marker)) {
    return `⏭️ 工单 #${issueNo} 的执行者已是「${name}」，无需重复安排。`;
  }

  // ① 飞书任务描述追加执行者（P→D plan-gate 闸门依据）
  const desc = (target.description ?? "").trimEnd();
  const pr = await callFeishuApi(ctx, {
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${guid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
    // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
    body: { update_fields: ["description"], task: { description: desc ? `${desc}\n${marker}` : marker } },
  });
  if (!pr.ok || (pr.value?.code ?? -1) !== 0) {
    return `❌ 记录执行者失败（任务侧）：${pr.ok ? pr.value?.msg : pr.error}`;
  }

  // ② Gitea 工单评论留痕（失败不阻断：任务侧已记录）
  const repoMatch = (target.summary ?? "").match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
  let giteaNote = "";
  if (repoMatch) {
    const cr = await callGiteaApi(ctx, {
      method: "POST",
      path: `${issuesBaseFor(`${repoMatch[1]}/${repoMatch[2]}`)}/${issueNo}/comments`,
      body: { body: `执行者安排：**${name}**（由项目小助理记录）` },
    });
    if (!cr.ok || !is2xx(cr.value?.status ?? 0)) giteaNote = `（工单评论失败：${cr.ok ? `HTTP ${cr.value?.status}` : cr.error}）`;
  }

  return `👤 工单 #${issueNo} 已安排执行者「${name}」${giteaNote}。任务将在下轮目标核对通过后进入「${SECTION_NAMES.doing}」执行队列。`;
}

// ── 意图处理（自 persona 迁入；建单/建任务接入双建同步） ──────────

/** 工单意图处理（增删改查 + 评论）；repo=意图显式 @仓库（短名在此解析为 full_name）。
 *  sessionChatId=来源群：缺 @仓库 时按群候选池归属（单仓自动落，多仓只列池内反问） */
async function handleIssueIntent(
  intent: Extract<TaskIntent, { kind: `issue-${string}` } | { kind: "issue-need-repo" }>,
  ctx: SeamContext,
  sessionChatId?: string,
): Promise<string> {
  const rawRepo = "repo" in intent ? intent.repo : undefined;
  let repo = rawRepo ? await resolveRepoInput(ctx, rawRepo) : undefined;

  if (intent.kind === "issue-need-repo") {
    const gd = await groupRepoDefault(ctx, sessionChatId);
    if (gd.auto) {
      return handleIssueIntent(
        { kind: "issue-create", repo: gd.auto, title: intent.title, body: intent.body },
        ctx,
        sessionChatId,
      );
    }
    return askForRepo(ctx, "建工单", intent.title, gd.pool);
  }

  if (intent.kind === "issue-create") {
    // 短名解析失败（0 或多个命中）同样反问，不猜仓库；未带 @仓库 先看来源群默认
    if (!repo) {
      if (rawRepo) return askForRepo(ctx, "建工单", intent.title);
      const gd = await groupRepoDefault(ctx, sessionChatId);
      if (gd.auto) repo = gd.auto;
      else return askForRepo(ctx, "建工单", intent.title, gd.pool);
    }
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
    const sync = await syncIssueToTask(ctx, repo, created ?? { title: intent.title }, sessionChatId);
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

/** 飞书任务意图处理（C 方案：建任务双向同步建工单，@仓库必填；
 *  缺 @仓库 时按来源群候选池归属——单仓自动落并注明，多仓只列池内反问） */
async function handleTaskIntent(
  intent: Extract<TaskIntent, { kind: "create" | "list" | "complete" | "task-need-repo" }>,
  ctx: SeamContext,
  sessionChatId?: string,
): Promise<string> {
  if (intent.kind === "task-need-repo") {
    const gd = await groupRepoDefault(ctx, sessionChatId);
    if (gd.auto) {
      return handleTaskIntent(
        { kind: "create", title: intent.title, dueDate: intent.dueDate, repo: gd.auto },
        ctx,
        sessionChatId,
      );
    }
    return askForRepo(ctx, "建任务", intent.title, gd.pool);
  }

  if (intent.kind === "create") {
    // C 方案：建任务必须带 @仓库（双向同步建工单）；缺仓先看来源群默认，再反问
    let repo: string | undefined;
    let groupNote = "";
    if (intent.repo) {
      repo = await resolveRepoInput(ctx, intent.repo);
      // 短名解析失败（0 或多个命中）：反问，不猜仓库
      if (!repo) return askForRepo(ctx, "建任务", intent.title);
    } else {
      const gd = await groupRepoDefault(ctx, sessionChatId);
      if (gd.auto) {
        repo = gd.auto;
        groupNote = `\n（已按本群归属到 ${repo}，如需其他仓库请 @仓库 重发）`;
      } else {
        return askForRepo(ctx, "建任务", intent.title, gd.pool);
      }
    }

    // 工单侧先查重：同名工单已存在则只建飞书任务，不重复建单
    const dup = await findIssue(ctx, repo, intent.title);
    if (dup.error) return `❌ 建任务前查重失败：${dup.error}`;

    const body: Record<string, unknown> = { summary: intent.title };
    if (intent.description) body.description = intent.description;
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
    const taskLine = `✅ 已创建任务：${t?.summary ?? intent.title}${intent.dueDate ? `（截止 ${intent.dueDate}）` : ""}${groupNote}`;

    if (dup.issue) {
      return `${taskLine}\n⚠️ ${repo} 已有同名工单（不重复建）：#${dup.issue.number} ${dup.issue.title?.trim()}`;
    }
    // 工单侧同步创建（部分失败不回滚已建任务）
    const ir = await callGiteaApi(ctx, {
      method: "POST",
      path: issuesBaseFor(repo),
      body: {
        title: intent.title,
        ...(intent.description || intent.dueDate
          ? {
              body: [
                intent.description ?? "",
                `> 来源：飞书任务双向同步${intent.dueDate ? `（截止 ${intent.dueDate}）` : ""}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
      },
    });
    if (!ir.ok || !is2xx(ir.value?.status ?? 0)) {
      return `${taskLine}\n⚠️ Gitea 工单同步失败：${ir.ok ? `HTTP ${ir.value?.status}` : ir.error}`;
    }
    const issue = ir.value?.data as IssueLike;
    // 工单建成功 → 顺手把飞书任务挂 org 清单（幂等补挂，失败不阻塞回执）
    const sync = await syncIssueToTask(ctx, repo, issue ?? {}, sessionChatId);
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
    // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
    body: { update_fields: ["completed_at"], task: { completed_at: new Date().toISOString() } },
  });
  if (!patchR.ok || (patchR.value?.code ?? -1) !== 0) {
    return `❌ 完结任务失败：${patchR.ok ? patchR.value?.msg || `code=${patchR.value?.code}` : patchR.error}`;
  }
  return `✅ 已完成：${target.summary?.trim()}`;
}

// ── Provider 实现 ────────────────────────────────────────────────

/** 单清单扫描：收编 → 完成回写 → plan-gate → dispatch-scan（scan 模式对每个 org 清单各跑一遍） */
async function runScanForList(
  ctx: SeamContext,
  listGuid: string,
  notifyChatId?: string,
): Promise<string[]> {
  // ⓪ 收编：飞书任务为先行主源——成员直接建到清单里的裸任务挪入 P
  let adoptedNote = "";
  try {
    const adopted = await adoptUnsectionedTasks(ctx, listGuid);
    if (adopted > 0) {
      adoptedNote = `📥 收编 ${adopted} 条清单裸任务进「${SECTION_NAMES.plan}」`;
      await dispatchNotify(notifyChatId, `📥 检测到 ${adopted} 条直接建在清单里的新任务，已收编进「${SECTION_NAMES.plan}」，将依次完成工单回填与执行者安排。`);
    }
  } catch (e) {
    console.error(`[task-issue-sync] 收编裸任务失败(不阻断): ${String(e)}`);
  }
  // ① Gitea 收尾完成回写（工单关闭+PR 合并 = 完成标识）
  let completionReports: string[] = [];
  try {
    completionReports = await syncCompletionFromGitea(ctx, { tasklistGuid: listGuid, notifyChatId });
  } catch (e) {
    console.error(`[task-issue-sync] 完成回写失败(不阻断): ${String(e)}`);
  }
  const planReports = await runPlanGate(ctx, { tasklistGuid: listGuid, notifyChatId });
  const dispatchReports = await runDispatchScan(ctx, { tasklistGuid: listGuid, notifyChatId });
  return [adoptedNote, ...completionReports, ...planReports, ...dispatchReports].filter(Boolean);
}

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
      const sync = await syncIssueToTask(ctx, request.repo, request.issue, request.sourceChatId);
      return ok({
        response: sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`,
      });
    }

    if (request.mode === "scan") {
      // 定时扫描模式：任务归属跨组织 → org 清单逐个跑（收编裸任务 → Gitea 完成回写
      // → plan-gate（执行者闸门+核对）→ dispatch-scan（派发+终态轮询））
      const all: string[] = [];
      if (request.tasklistGuid) {
        all.push(...(await runScanForList(ctx, request.tasklistGuid, request.notifyChatId)));
      } else {
        const names = request.tasklistNames?.length
          ? request.tasklistNames
          : [request.tasklistName ?? "TiMEM-AI"];
        for (const name of names) {
          const list = await ensureTasklist(ctx, name);
          if (list.error || !list.guid) {
            all.push(`⚠️ 扫描跳过：任务清单「${name}」不可用：${list.error}`);
            continue;
          }
          all.push(...(await runScanForList(ctx, list.guid, request.notifyChatId)));
        }
      }
      return ok({ response: all.length ? all.join("\n") : "（本轮无待处理任务）" });
    }

    const intent = request.intent;
    const sessionChatId = request.session_id;
    let response: string;
    if (intent.kind === "help") {
      response = "（帮助文本由 persona 层提供）";
    } else if (intent.kind === "overview") {
      response = await buildOverview(ctx);
    } else if (intent.kind === "dispatch-confirm") {
      response = await handleDispatchConfirm(ctx, intent.ref);
    } else if (intent.kind === "dispatch-cancel") {
      response = await handleDispatchCancel(ctx, intent.ref);
    } else if (intent.kind === "assign") {
      response = await handleAssignExecutor(ctx, intent.ref, intent.executor);
    } else if (intent.kind === "pending-assign") {
      response = await handlePendingAssign(ctx, intent.ref, intent.repo, sessionChatId);
    } else if (intent.kind === "pending-skip") {
      response = handlePendingSkip(intent.ref, sessionChatId);
    } else if (intent.kind === "task-need-repo" || intent.kind === "create" || intent.kind === "list" || intent.kind === "complete") {
      response = await handleTaskIntent(intent, ctx, sessionChatId);
    } else {
      response = await handleIssueIntent(intent, ctx, sessionChatId);
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
