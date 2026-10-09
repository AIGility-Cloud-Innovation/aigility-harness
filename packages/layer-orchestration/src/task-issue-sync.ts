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
  findPendingCandidateByNo,
  jaccard,
  llmInferenceRef,
  mappedChatPool,
  pendingNosForRootMessage,
  peekPendingCandidate,
  quoteDiscussion,
  takePendingCandidate,
} from "./task-pipeline.js";
// 项目简称解析（config/project-registry.json 的 aliases）与人员别名解析
// （config/timem-team-registry.json）——「任务归属 1 太忆」「安排执行者 1 hongbin」
import { getProjectRegistry, resolveProjectRef, projectRepoScope } from "./project-registry.js";
import { getIdentityRegistry, resolveMemberByName } from "./identity-registry.js";
// 项目小助理事件快照：建单/完成等显著变化 → 防抖后写入 timem（briefing-events 内部节流）
import { notifyRepoActivity } from "./briefing-events.js";

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
  | { kind: "create"; title: string; dueDate?: string; repo?: string; description?: string; executor?: string }
  | { kind: "list" }
  | { kind: "complete"; keyword: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string; executor?: string }
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
  /** 澄清归属确认：「任务归属 N 仓库/项目简称」——核验摘要判断或落澄清候选。
   *  摘要统一播报到机器人群后，回复可能来自机器人群或私聊，认领按编号全局定位
   *  （不再限定来源群）；简称经项目登记表解析，解析失败反问。 */
  | { kind: "pending-assign"; ref: string; repo: string }
  /** 澄清归属放弃：「跳过任务 N」——丢弃澄清队列候选，不建单 */
  | { kind: "pending-skip"; ref: string }
  /** 摘要核验确认：「确认 N」——认可 LLM 判断（项目/执行人），digest-only 下仅记录 */
  | { kind: "confirm-pending"; ref: string }
  /** 多行澄清归属：一条消息逐行「任务归属 N 仓库 / 安排执行者 N 姓名 / 确认 N / 跳过任务 N」（逐条落单） */
  | {
      kind: "pending-batch";
      items: Array<
        | { action: "assign"; ref: string; repo: string }
        | { action: "skip"; ref: string }
        | { action: "confirm"; ref: string }
        | { action: "assign-executor"; ref: string; executor: string }
      >;
    }
  | { kind: "overview" }
  | { kind: "help" };

// ── 请求/响应 ────────────────────────────────────────────────────

export type TaskIssueSyncRequest =
  | {
      /** 意图模式：persona 解析后委托业务处理，返回用户回复文本 */
      mode: "intent";
      intent: TaskIntent;
      session_id?: string;
      /** 引用回复的消息 id（摘要核验指令省略编号时反查条目用） */
      root_id?: string;
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
    }
  | {
      /** 原语模式：飞书先行——建「计划中」飞书任务（不带 [repo#N] 前缀），挂 org 清单 P 分组。
       *  task-pipeline 汇总后调用；归属+执行者齐备前不建 Gitea 工单。 */
      mode: "create-planned";
      /** 归属参考仓库（org/仓库；只用其 org 解析清单） */
      repo: string;
      /** 任务标题（原样，不加前缀） */
      title: string;
      /** 优先级（P0-P3，写进标题前缀） */
      priority?: string;
      /** 任务信息来源群 chatId（写入任务描述，plan-gate 提问/汇总可回溯） */
      sourceChatId?: string;
      /** 原始讨论消息文本（判定输入同序；进任务描述「原始讨论」段，2026-10-05 补齐） */
      texts?: string[];
      /** LLM 引用的消息下标（1-based；缺省引用全部） */
      sources?: number[];
    };

export interface TaskIssueSyncResponse {
  /** 用户回复文本（intent 模式）或同步结果摘要（sync-issue 模式） */
  response: string;
  session_id?: string;
  /** create-planned 模式：新建飞书任务 guid（pipeline 存进澄清候选，归属确认后改写用） */
  taskGuid?: string;
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
  // 项目简称优先：登记表别名/名称（太忆、电信平台…）→ 项目 → 仓库范围；
  // 单仓库项目直接定仓，多仓库/组织级项目走后续仓库名匹配
  const ref = resolveProjectRef(getProjectRegistry(), input);
  if (ref.project) {
    const scope = projectRepoScope(ref.project);
    if (scope.repos.length === 1 && scope.orgs.length === 0) return scope.repos[0];
  }
  const repos = await candidateRepos(ctx);
  const kw = input.toLowerCase();
  const exact = repos.filter((r) => r.toLowerCase().split("/")[1] === kw);
  if (exact.length === 1) return exact[0];
  const fuzzy = repos.filter((r) => r.toLowerCase().split("/")[1].includes(kw));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

/** 项目简称解析摘要（反问用）：「太忆 → TiMEM 平台（4 仓库）」一行一个 */
function projectAliasHints(): string[] {
  const file = getProjectRegistry();
  return file.projects.map((p) => {
    const scope = projectRepoScope(p);
    const n = scope.repos.length + scope.orgs.length;
    return `• ${p.name}（简称：${(p.aliases ?? []).join(" / ") || "无"}，${n} 个仓库）`;
  });
}

/**
 * 归属输入解析：项目简称（登记表）→ 模糊命中多个项目时返回歧义候选；
 * 单项目多仓库时返回该项目仓库列表让用户挑。repo 命中则直接返回。
 */
async function resolveRepoOrAsk(
  ctx: SeamContext,
  input: string,
): Promise<{ repo?: string; ask?: string }> {
  const file = getProjectRegistry();
  const ref = resolveProjectRef(file, input);
  if (ref.project) {
    const scope = projectRepoScope(ref.project);
    if (scope.repos.length === 1 && scope.orgs.length === 0) return { repo: scope.repos[0] };
    if (scope.repos.length > 1) {
      return {
        ask:
          `「${input}」对应项目「${ref.project.name}」覆盖 ${scope.repos.length} 个仓库，请用全名指明：\n` +
          scope.repos.map((r) => `• ${r}`).join("\n"),
      };
    }
  } else if (ref.ambiguous && ref.ambiguous.length > 1) {
    return {
      ask:
        `「${input}」命中多个项目，请指明是哪个：\n` +
        ref.ambiguous.map((p) => `• ${p.name}（简称：${(p.aliases ?? []).join(" / ")}）`).join("\n"),
    };
  }
  const repo = await resolveRepoInput(ctx, input);
  if (repo) return { repo };
  return {
    ask:
      `❌ 「${input}」解析不出项目/仓库。可用项目简称：\n` +
      projectAliasHints().join("\n") +
      `\n或用 组织/仓库 全名重试。`,
  };
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
  executor?: string,
  texts?: string[],
  sources?: number[],
): Promise<{ ok: boolean; detail: string }> {
  const listName = tasklistNameForRepo(repo);
  const list = await ensureTasklist(ctx, listName);
  if (list.error || !list.guid) {
    return { ok: false, detail: `清单「${listName}」不可用：${list.error}` };
  }
  const body: Record<string, unknown> = { summary: syncTaskSummary(repo, issue) };
  const descParts: string[] = [];
  if (issue.html_url) descParts.push(`工单链接：${issue.html_url}`);
  if (sourceChatId) descParts.push(`来源群：${await resolveChatName(ctx, sourceChatId)}`);
  // 执行者是 plan-gate 的 P→D 闸门依据（/执行者：\S+/）
  if (executor) descParts.push(`执行者：${executor}`);
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

/**
 * 飞书先行：建「计划中」飞书任务（syncIssueToTask 的姊妹原语，飞书为先行主源）。
 * 标题 `[优先级] 标题`（不带 [repo#N] 前缀——工单号要等归属+执行者齐备回填才有），
 * 挂 org 清单（按 repo 的 org 解析，缺则自动创建）的「P 计划中」分组。
 * 返回 guid：pipeline 存进澄清候选，归属确认后改写标题/挪分组（而非重建）。
 */
export async function createPlannedTask(
  ctx: SeamContext,
  opts: { repo: string; title: string; priority?: string; sourceChatId?: string; texts?: string[]; sources?: number[] },
): Promise<{ ok: boolean; guid?: string; detail: string }> {
  const listName = tasklistNameForRepo(opts.repo);
  const list = await ensureTasklist(ctx, listName);
  if (list.error || !list.guid) {
    return { ok: false, detail: `清单「${listName}」不可用：${list.error}` };
  }
  const body: Record<string, unknown> = {
    summary: opts.priority ? `[${opts.priority}] ${opts.title}` : opts.title,
  };
  const descParts: string[] = [];
  if (opts.sourceChatId) descParts.push(`来源群：${await resolveChatName(ctx, opts.sourceChatId)}`);
  descParts.push("状态：待确认归属与执行者（两者齐备后自动创建 Gitea 工单）");
  const supTexts = opts.texts;
  if (supTexts && supTexts.length > 0) {
    const idx = (opts.sources ?? supTexts.map((_, i) => i + 1))
      .map((n) => n - 1)
      .filter((i) => i >= 0 && i < supTexts.length)
      .slice(0, 5);
    const quoted = (idx.length > 0 ? idx : supTexts.map((_, i) => i))
      .slice(0, 5)
      .map((i) => `> ${supTexts[i].replace(/\n/g, "\n> ")}`.slice(0, 500));
    if (quoted.length > 0) descParts.push(`原始讨论：\n${quoted.join("\n")}`);
  }
  body.description = descParts.join("\n");
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
  // 挂清单 + 「P 计划中」分组（一次 add_tasklist 带 section_guid；分组缺则自动建）
  const sections = await ensureSections(ctx, list.guid);
  const planGuid = sections.plan;
  const ar = await callFeishuApi(ctx, {
    method: "POST",
    path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { tasklist_guid: list.guid, ...(planGuid ? { section_guid: planGuid } : {}) },
  });
  if (!ar.ok || (ar.value?.code ?? -1) !== 0) {
    return {
      ok: true,
      guid: taskGuid,
      detail: `任务已建但挂清单「${listName}」失败：${ar.ok ? ar.value?.msg || `code=${ar.value?.code}` : ar.error}`,
    };
  }
  return { ok: true, guid: taskGuid, detail: `已建飞书任务并归入「${listName}」·${SECTION_NAMES.plan}` };
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

/** 双建任务标题 [org/repo#N] → { repo, issueNo }（解析不出返回 undefined） */
export function taskIssueRefFromSummary(
  summary: string | undefined,
): { repo: string; issueNo: number } | undefined {
  const m = (summary ?? "").match(/\[([^\]#/]+)\/([^\]#]+)#(\d+)\]/);
  return m ? { repo: `${m[1]}/${m[2]}`, issueNo: Number(m[3]) } : undefined;
}

/** 飞书先行任务标题 [org/repo] 前缀（归属已确认标记）→ 仓库 full_name（解析不出 undefined） */
export function repoFromPlannedSummary(summary: string | undefined): string | undefined {
  const m = (summary ?? "").match(/^\[([^\]#/]+)\/([^\]#/]+)\]/);
  return m ? `${m[1]}/${m[2]}` : undefined;
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

/** chat_id → 群名缓存（群名基本不变；查不到回退原始 ID） */
const chatNameCache = new Map<string, string>();

/** 群聊显示名：写进任务描述给人看的「来源群」用群名，不用 oc_ ID（2026-10-05 用户反馈） */
export async function resolveChatName(ctx: SeamContext, chatId: string): Promise<string> {
  if (!chatId || chatId === "*") return "未知";
  const cached = chatNameCache.get(chatId);
  if (cached) return cached;
  const r = await callFeishuApi(ctx, {
    method: "GET",
    path: `/open-apis/im/v1/chats/${chatId}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  const name =
    r.ok && (r.value?.code ?? -1) === 0
      ? ((r.value?.data as { name?: string })?.name ?? chatId)
      : chatId;
  chatNameCache.set(chatId, name);
  return name;
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
    notifyRepoActivity(repo, `工单 #${issueNo} 关闭${mergedPr ? "（PR 已合并）" : ""}`);
    await dispatchNotify(opts.notifyChatId, msg);
  }
  return reports;
}

/**
 * 反向闭环（2026-10-10）：任务完成 → 工单收尾。
 * 规则（用户拍板）：工单或任务任一侧关闭 = 任务完成 = 双侧收尾。
 *   - complete 意图关任务后调用：带 [org/repo#N] 标题 → 关工单 + 评论产出说明；
 *   - runScanForList 对账闸门调用：扫到已完成任务其工单仍 open → 补关（幂等）。
 * 返回回执文本；工单引用解析不出返回 undefined（纯任务，无工单侧动作）。
 */
export async function closeIssueForCompletedTask(
  ctx: SeamContext,
  summary: string | undefined,
  opts: { reason?: string; notifyChatId?: string } = {},
): Promise<string | undefined> {
  const ref = taskIssueRefFromSummary(summary);
  if (!ref) return undefined;
  const { repo, issueNo } = ref;
  const r = await callGiteaApi(ctx, {
    method: "PATCH",
    path: `${issuesBaseFor(repo)}/${issueNo}`,
    body: { state: "closed" },
  });
  const patched = r.value?.data as { state?: string; number?: number } | undefined;
  if (!r.ok || !is2xx(r.value?.status ?? 0) || (patched?.state ?? "open") !== "closed") {
    return `⚠️ 工单 ${repo}#${issueNo} 关闭失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
  }
  const reason = opts.reason ?? "飞书任务已完成";
  await callGiteaApi(ctx, {
    method: "POST",
    path: `${issuesBaseFor(repo)}/${issueNo}/comments`,
    body: { body: `✅ ${reason}，按「任一侧关闭 = 完成」规则同步关闭本工单。` },
  }).catch(() => undefined);
  const msg = `🔒 「${(summary ?? "").replace(/^\[[^\]]+\]\s*/, "").slice(0, 40)}」已完成，工单 ${repo}#${issueNo} 已同步关闭。`;
  notifyRepoActivity(repo, `任务完成，工单 #${issueNo} 同步关闭`);
  await dispatchNotify(opts.notifyChatId, msg);
  return msg;
}

/** 群通知注入（装配层 set；与 task-pipeline.setNotifySend 同款约定） */
let dispatchNotifySend: ((chatId: string, text: string) => Promise<string | void>) | undefined;
export function setDispatchNotifySend(fn: ((chatId: string, text: string) => Promise<string | void>) | undefined): void {
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

    // ⓪ 执行者闸门（先于回填建单）：未安排执行者的任务不进入执行（需群里「安排执行者」）
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
      reports.push(`👤 「${summary.slice(0, 40)}」尚未安排执行者，留 P。群里回复「安排执行者 ${issueNo !== undefined ? `#${issueNo}` : "编号"} @姓名」后自动进入执行。`);
      continue;
    }

    // ⓪-a 先行任务回填工单（归属+执行者齐备才建）：没有 #N 的 P 任务，标题带
    // [org/repo] 前缀（归属已确认）→ 从标题解析仓库自动建 Gitea 工单并同步回写 #N；
    // 缺前缀 = 归属未确认 → 打【待确认归属】留 P，等群里「任务归属」确认。
    if (issueNo === undefined && !summary.includes("【待补充】")) {
      const prefix = summary.match(/^\[([^\]]+)\]/);
      if (!prefix) {
        const tagged = `【待确认归属】${summary.replace(/^【待确认归属】/, "")}`;
        if (tagged !== summary) {
          await callFeishuApi(ctx, {
            method: "PATCH",
            path: `/open-apis/task/v2/tasks/${guid}`,
            query: { user_id_type: "open_id" },
            identity: "user",
            body: { update_fields: ["summary"], task: { summary: tagged } },
          }).catch(() => undefined);
        }
        reports.push(`🏷️ 「${summary.slice(0, 40)}」尚未确认归属，留 P。群里回复「任务归属 编号 @仓库」确认后自动创建工单。`);
        continue;
      }
      // 前缀解析仓库：含 / 取 org/仓库；解析不出回退默认仓库并告警（不卡队列）
      const parsedRepo = repoFromPlannedSummary(summary);
      const repo = parsedRepo ?? giteaRepo();
      if (!parsedRepo) {
        reports.push(`⚠️ 「${summary.slice(0, 40)}」标题前缀解析不出仓库，回退默认仓库 ${repo} 回填工单。`);
      }
      const cleanTitle = summary.replace(/^【[^】]+】/, "").replace(/^\[[^\]]+\]\s*/, "").trim();
      const ir = await callGiteaApi(ctx, {
        method: "POST",
        path: issuesBaseFor(repo),
        body: {
          title: cleanTitle,
          body: `> 来源：飞书任务（归属+执行者已确认，由项目小助理回填工单）\n>\n> 飞书任务：${summary.slice(0, 80)}`,
        },
      });
      if (ir.ok && is2xx(ir.value?.status ?? 0)) {
        const issue = ir.value?.data as { number?: number; html_url?: string };
        const sync = await syncIssueToTask(ctx, repo, issue);
        reports.push(
          sync.ok
            ? `🔗 「${cleanTitle.slice(0, 40)}」已回填工单 ${repo}#${issue.number}（双建完成），可「确认派发 #${issue.number}」。`
            : `⚠️ 「${cleanTitle.slice(0, 40)}」工单 ${repo}#${issue.number} 已建但同步任务失败：${sync.detail}`,
        );
      } else {
        reports.push(`⚠️ 「${cleanTitle.slice(0, 40)}」回填工单失败，下轮重试：${ir.ok ? `HTTP ${ir.value?.status}` : ir.error}`);
      }
      continue; // 本轮先完成回填，下轮再走目标核对闸门
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

/**
 * 「任务归属 N @仓库」（飞书先行）：不再建工单——把候选携带的飞书任务标题改写为
 * `[repo] 原标题`（归属已确认标记，plan-gate 回填建单的依据），并确保任务挂在
 * 目标 org 清单的「P 计划中」分组（org 相同则原地，add_tasklist 幂等）。
 * 候选保留在队列（标记 assignedRepo），后续「安排执行者 N @姓名」仍按编号定位。
 * 无 guid 的旧候选（历史遗留）回落原「建工单+双建」行为。
 */
/**
 * 核验指令的条目定位：优先显式编号；ref 为空（引用摘要回复省略编号）时用
 * root_id（被引用的摘要消息）反查——唯一存活条目直接用，多条/零条则反问。
 */
function resolvePendingRef(
  ref: string,
  rootId?: string,
): { no?: number; item?: ReturnType<typeof findPendingCandidateByNo>; ask?: string } {
  const num = ref.trim().match(/^#?(\d+)$/);
  if (num) {
    const no = Number(num[1]);
    const item = findPendingCandidateByNo(no);
    return item ? { no, item } : { ask: `没有找到待核验任务 #${no}（可能已处理、已跳过或已过期）。` };
  }
  const alive = pendingNosForRootMessage(rootId)
    .map((n) => findPendingCandidateByNo(n))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  if (alive.length === 1) return { no: alive[0].no, item: alive[0] };
  if (alive.length > 1) {
    return {
      ask:
        `引用的摘要里有 ${alive.length} 条待核验条目，请带上编号：\n` +
        alive.map((i) => `• #${i.no} [${i.priority}] ${i.title}`).join("\n"),
    };
  }
  return { ask: "缺编号：请带上条目编号（如「确认 #12」），或引用单条摘要回复。" };
}

async function handlePendingAssign(
  ctx: SeamContext,
  ref: string,
  repoInput: string,
  sessionChatId?: string,
  rootId?: string,
): Promise<string> {
  const located = resolvePendingRef(ref, rootId);
  if (located.ask || !located.item) return located.ask ?? "用法：任务归属 编号 仓库/项目简称";
  const no = located.no as number;
  const item = located.item;
  if (!sessionChatId) return "❌ 需要在识别到该任务的群里回复（私聊缺少群上下文）。";
  const resolved = await resolveRepoOrAsk(ctx, repoInput);
  if (!resolved.repo) return resolved.ask ?? "❌ 仓库解析失败";

  // 摘要核验（digest-only 记录模式）：仅记录归属，不建单不建任务——
  // 建单由工作流 YAML 的建单节点负责，现阶段全部禁用
  if (item.fromDigest && !item.feishuTaskGuid) {
    item.assignedRepo = resolved.repo;
    const executor = item.executor ?? item.suggestedExecutor;
    return (
      `✅ 已记录 #${no}「${item.title}」归属 ${resolved.repo}${executor ? ` · 执行人 ${executor}` : ""}（现阶段仅记录，不建任务/工单）` +
      (executor ? `\n对了就回复「确认 ${no}」完成核验。` : `\n再回复「安排执行者 ${no} 姓名」补执行人，或「确认 ${no}」完成核验。`)
    );
  }

  const repo = resolved.repo;

  // 飞书先行：候选带飞书任务 guid → 改标题 + 挪目标 org 清单 P 分组（不建工单）
  if (item.feishuTaskGuid) {
    if (item.assignedRepo === repo) {
      return `⏭️ 待归属任务 #${no} 已确认归属 ${repo}，无需重复确认。`;
    }
    const guid = item.feishuTaskGuid;
    const clean = item.title.replace(/^\[[^\]]+\]\s*/, "").trim();
    const pr = await callFeishuApi(ctx, {
      method: "PATCH",
      path: `/open-apis/task/v2/tasks/${guid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
      // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
      body: { update_fields: ["summary"], task: { summary: `[${repo}] ${clean}` } },
    });
    if (!pr.ok || (pr.value?.code ?? -1) !== 0) {
      return `❌ 归属确认失败（改写任务标题）：${pr.ok ? pr.value?.msg : pr.error}`;
    }
    // 挂到目标 org 清单的「P 计划中」分组；同 org 原地时 add_tasklist 失败按幂等忽略
    const listName = tasklistNameForRepo(repo);
    const list = await ensureTasklist(ctx, listName);
    let sectionNote = "";
    if (!list.error && list.guid) {
      const sections = await ensureSections(ctx, list.guid);
      if (sections.plan) {
        const ar = await callFeishuApi(ctx, {
          method: "POST",
          path: `/open-apis/task/v2/tasks/${guid}/add_tasklist`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { tasklist_guid: list.guid, section_guid: sections.plan },
        });
        if (ar.ok && (ar.value?.code ?? -1) === 0) sectionNote = `，已归入「${listName}」·${SECTION_NAMES.plan}`;
      }
    }
    // 候选保留（回填 assignedRepo）：「安排执行者 N」仍按编号定位任务
    item.assignedRepo = repo;
    return [
      `✅ 待归属任务 #${no} 已确认归属 ${repo}：${clean}${sectionNote}`,
      `请回复「安排执行者 ${no} @姓名」指定执行者；归属+执行者齐备后自动创建 Gitea 工单。`,
    ].join("\n");
  }

  // 旧链路回落（无 guid 的历史候选）：建工单 + 双建（与自动汇总旧行为一致）
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
      body:
        `> 来源：飞书群聊自动汇总（${item.collectedAt}，群内澄清归属）\n>\n> 判定依据：${item.reason ?? "LLM 判定为待执行任务"}\n> 来源群：${sessionChatId}\n` +
        (quoteDiscussion(item.texts, item.sources) ? `\n${quoteDiscussion(item.texts, item.sources)}\n` : "\n") +
        `\n由 @orchestration/task-pipeline 自动创建，请负责人认领。`,
    },
  });
  if (!r.ok || !is2xx(r.value?.status ?? 0)) {
    return `❌ 建工单失败：${r.ok ? `HTTP ${r.value?.status}` : r.error}`;
  }
  const created = r.value?.data as IssueLike;
  const sync = await syncIssueToTask(ctx, repo, created ?? { title: item.title }, sessionChatId);
  notifyRepoActivity(repo, `澄清归属建工单 ${repo}#${created?.number ?? "?"}`);
  return [
    `✅ 已建工单 ${repo} #${created?.number}：${item.title}`,
    created?.html_url ?? "",
    sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`,
    `请回复「安排执行者 #${created?.number ?? "?"} @姓名」指定执行者。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 「跳过任务 N」：丢弃澄清候选，不建单（认领放宽：机器人群/私聊回复均可） */
function handlePendingSkip(ref: string, sessionChatId?: string, rootId?: string): string {
  const located = resolvePendingRef(ref, rootId);
  if (located.ask || !located.item) return located.ask ?? "用法：跳过任务 编号";
  const item = located.item;
  takePendingCandidate(item.chatId, item.no);
  return `🚮 已丢弃 #${item.no}「${item.title}」，不会建单。`;
}

/**
 * 「确认 N」：核验摘要条目的 LLM 判断（项目/执行人）。
 * 两者齐备 → 消费队列项并记录；缺项 → 反问补哪一项（不消费，可继续补）。
 * digest-only 阶段仅记录，不建任务/工单（建单由工作流建单节点负责）。
 */
function handlePendingConfirm(ref: string, sessionChatId?: string, rootId?: string): string {
  const located = resolvePendingRef(ref, rootId);
  if (located.ask || !located.item) return located.ask ?? "用法：确认 编号";
  const item = located.item;
  const no = item.no;
  // 低置信归属（私聊/并集池猜测）不算已定项目，确认时要求人工明确
  const repo = item.assignedRepo ?? (item.repoUncertain ? undefined : item.suggestedRepo);
  const executor = item.executor ?? item.suggestedExecutor;
  if (!repo || !executor) {
    const missing = [repo ? undefined : "项目", executor ? undefined : "执行人"]
      .filter(Boolean)
      .join("和");
    return (
      `❓ #${no}「${item.title}」还差${missing}：` +
      [repo ? undefined : `「任务归属 ${no} 项目简称」`, executor ? undefined : `「安排执行者 ${no} 姓名」`]
        .filter(Boolean)
        .join("、") +
      ` 补齐后再确认。`
    );
  }
  takePendingCandidate(item.chatId, no);
  return `✅ #${no}「${item.title}」已核验：项目 ${repo} · 执行人 ${executor}（现阶段仅记录，不建任务/工单）。`;
}

/**
 * 安排执行者：「安排执行者 #N @张三」。定位优先级：
 *   ① 纯数字且澄清队列有该编号候选（飞书先行，建单前）→ 按候选的飞书任务 guid 定位；
 *   ② ref 本身是任务 guid → 直接定位；
 *   ③ 回落工单号路径（双建任务 [repo#N] 反查，既有行为保留）。
 * 双写：飞书任务描述追加「执行者：X」（P→D 闸门与回填建单的判定依据）+
 * Gitea 工单评论留痕（仅建单后路径，未建单无工单可评）。
 */
/** 摘要条目（digest-only）执行者记录：仅写回候选，不动飞书任务/工单 */
function recordDigestExecutor(
  item: NonNullable<ReturnType<typeof findPendingCandidateByNo>>,
  executorName: string,
): string {
  item.executor = executorName;
  const repo = item.assignedRepo ?? item.suggestedRepo;
  return (
    `✅ 已记录 #${item.no}「${item.title}」执行人 ${executorName}${repo ? ` · 项目 ${repo}` : ""}（现阶段仅记录，不建任务/工单）\n` +
    `对了就回复「确认 ${item.no}」完成核验。`
  );
}

/**
 * 执行者姓名解析（人员登记表别名）：命中返回规范名；登记表非空但没命中/歧义
 * 返回反问文案（不写任何数据）。登记表为空保持旧行为原样使用。
 */
function resolveExecutorName(name: string): string | false {
  const reg = getIdentityRegistry();
  const members = (reg.members ?? []).filter((m) => m.name);
  if (members.length === 0) return name;
  const m = resolveMemberByName(reg, name);
  if (m.kind === "exact") return m.member.name;
  if (m.kind === "ambiguous") {
    console.error(
      `❓ 「${name}」命中多个成员：${m.candidates.map((c) => c.name).join(" / ")}，请用登记名重试。`,
    );
    return false;
  }
  console.error(
    `❌ 人员登记表里没有「${name}」。已登记成员：${members.map((c) => c.name).join("、")}；也可用其中任何别名（如中文名/花名/拼音）。`,
  );
  return false;
}

async function handleAssignExecutor(
  ctx: SeamContext,
  ref: string,
  executor: string,
  rootId?: string,
): Promise<string> {
  const raw = ref.trim();
  const num = raw.match(/^#?(\d+)$/);
  const name = executor.replace(/^@/, "").trim();
  if (!name) return "❌ 请带上执行者姓名，如：安排执行者 #12 @张三";

  // 人员别名 → 登记表规范名（hongbin → shahongbin；中文名/花名/拼音同表）。
  // 登记表非空且解析不到 → 反问列出成员（不写任何数据）；歧义同样反问。
  const resolvedName = resolveExecutorName(name);
  if (resolvedName === false) {
    const members = (getIdentityRegistry().members ?? []).filter((m) => m.name);
    return (
      `❌ 执行者「${name}」解析失败。已登记成员：${members.map((c) => c.name).join("、")}；` +
      `也可用其中任何别名（如中文名/花名/拼音）。`
    );
  }
  const executorName = resolvedName;

  // ref 为空（引用摘要回复省略编号）→ root 反查摘要条目；编号/guid 路径不变
  if (!raw) {
    const located = resolvePendingRef("", rootId);
    if (located.ask || !located.item) return located.ask ?? "用法：安排执行者 #编号 姓名";
    const item = located.item;
    if (!item.fromDigest || item.feishuTaskGuid) {
      return "❌ 引用的摘要条目不能这样安排执行者，请带上 #编号或任务 guid。";
    }
    return recordDigestExecutor(item, executorName);
  }

  // ① 建单前：编号命中澄清队列候选（带飞书任务 guid）→ 按 guid 定位
  let guidFilter: string | undefined;
  let pendingNo: number | undefined;
  let issueNo: number | undefined;
  if (num) {
    const pending = findPendingCandidateByNo(Number(num[1]));
    // 摘要核验（digest-only 记录模式）：仅记录执行人，不动飞书任务/工单
    if (pending?.fromDigest && !pending.feishuTaskGuid) {
      return recordDigestExecutor(pending, executorName);
    }
    if (pending?.feishuTaskGuid) {
      guidFilter = pending.feishuTaskGuid;
      pendingNo = pending.no;
    } else {
      issueNo = Number(num[1]);
    }
  } else {
    // ② ref 本身当作飞书任务 guid
    guidFilter = raw;
  }

  // 全量任务列表定位目标任务
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
  const target = guidFilter
    ? items.find((t) => (t.guid ?? t.task_id) === guidFilter)
    : items.find((t) => issueNumberFromTaskSummary(t.summary ?? "") === issueNo);
  if (!target?.guid && !target?.task_id) {
    return pendingNo !== undefined
      ? `没有找到澄清任务 #${pendingNo} 对应的飞书任务。`
      : `没有找到工单 #${issueNo} 对应的飞书任务（可能尚未双建）。`;
  }
  const guid = (target.guid ?? target.task_id) as string;
  const marker = `执行者：${executorName}`;
  if ((target.description ?? "").includes(marker)) {
    return `⏭️ ${pendingNo !== undefined ? `澄清任务 #${pendingNo}` : `工单 #${issueNo}`} 的执行者已是「${executorName}」，无需重复安排。`;
  }

  // 飞书任务描述追加执行者（plan-gate 闸门依据）
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

  // 建单后路径：Gitea 工单评论留痕（失败不阻断：任务侧已记录）
  const repoMatch = (target.summary ?? "").match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
  let giteaNote = "";
  if (repoMatch && issueNo !== undefined) {
    const cr = await callGiteaApi(ctx, {
      method: "POST",
      path: `${issuesBaseFor(`${repoMatch[1]}/${repoMatch[2]}`)}/${issueNo}/comments`,
      body: { body: `执行者安排：**${executorName}**（由项目小助理记录）` },
    });
    if (!cr.ok || !is2xx(cr.value?.status ?? 0)) giteaNote = `（工单评论失败：${cr.ok ? `HTTP ${cr.value?.status}` : cr.error}）`;
  }

  return pendingNo !== undefined
    ? `👤 澄清任务 #${pendingNo} 已安排执行者「${executorName}」。请再回复「任务归属 ${pendingNo} 仓库/项目简称」确认归属；两者齐备后自动创建 Gitea 工单。`
    : `👤 工单 #${issueNo} 已安排执行者「${executorName}」${giteaNote}。任务将在下轮目标核对通过后进入「${SECTION_NAMES.doing}」执行队列。`;
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
    // 建单时顺带指派执行人（「… 安排给 徐彬程」已由 persona 剥离标题）：
    // 登记表命中用规范名，未命中按原样记录并在回执提示
    let executorName: string | undefined;
    let executorNote = "";
    if (intent.executor) {
      const resolved = resolveExecutorName(intent.executor);
      executorName = typeof resolved === "string" ? resolved : intent.executor;
      if (typeof resolved !== "string") executorNote = `\n⚠️ 执行者「${intent.executor}」不在人员登记表，已按原样记录。`;
    }
    // ── C 方案双向同步：工单建成功 → 飞书任务挂 org 清单（部分失败不回滚） ──
    const sync = await syncIssueToTask(ctx, repo, created ?? { title: intent.title }, sessionChatId, executorName);
    const syncLine = sync.ok ? `📋 ${sync.detail}` : `⚠️ 飞书同步未完成：${sync.detail}`;
    notifyRepoActivity(repo, `新建工单 ${repo}#${created?.number ?? "?"}`);
    return `✅ 已建工单 ${giteaRepo(repo)} #${created?.number}：${created?.title ?? intent.title}${
      intent.body ? "（含正文）" : ""
    }${executorName ? `\n👤 执行人：${executorName}` : ""}\n${created?.html_url ?? ""}\n${syncLine}${executorNote}`.trimEnd();
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

    let executorName: string | undefined;
    let executorNote = "";
    if (intent.executor) {
      const resolved = resolveExecutorName(intent.executor);
      executorName = typeof resolved === "string" ? resolved : intent.executor;
      if (typeof resolved !== "string") executorNote = `\n⚠️ 执行者「${intent.executor}」不在人员登记表，已按原样记录。`;
    }
    const body: Record<string, unknown> = { summary: intent.title };
    const descLines = [intent.description, executorName ? `执行者：${executorName}` : ""].filter(Boolean);
    if (descLines.length > 0) body.description = descLines.join("\n");
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
    const sync = await syncIssueToTask(ctx, repo, issue ?? {}, sessionChatId, executorName);
    const syncLine = sync.ok ? `📋 ${sync.detail}` : `⚠️ ${sync.detail}`;
    return `${taskLine}${executorName ? `\n👤 执行人：${executorName}` : ""}\n🎫 已同步建工单 ${repo} #${issue?.number}：${issue?.title ?? intent.title}\n${
      issue?.html_url ?? ""
    }\n${syncLine}${executorNote}`.trimEnd();
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
  // 反向闭环（2026-10-10 用户拍板：任一侧关闭 = 完成 = 双侧收尾）：任务完结 → 同步关工单
  const closure = await closeIssueForCompletedTask(ctx, target.summary, { reason: "「完成」指令完结飞书任务" }).catch(() => undefined);
  return `✅ 已完成：${target.summary?.trim()}${closure ? `\n${closure}` : ""}`;
}

// ── Provider 实现 ────────────────────────────────────────────────

/** 拉任务清单的已完成任务（反向对账用：任一侧关闭=完成，扫已完成任务的工单侧是否漏收尾） */
async function listCompletedTasksWithIssue(
  ctx: SeamContext,
  tasklistGuid: string,
): Promise<Array<{ guid?: string; task_id?: string; summary?: string }>> {
  const fr = await callFeishuApi(ctx, {
    method: "GET",
    path: `/open-apis/task/v2/tasklists/${tasklistGuid}/tasks`,
    query: { completed: true, page_size: 50, user_id_type: "open_id" },
    identity: "user",
  });
  if (!fr.ok || (fr.value?.code ?? -1) !== 0) return [];
  return (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string }> })?.items ?? [];
}

/** 单清单扫描：收编 → 完成回写 → 反向对账 → plan-gate → dispatch-scan（scan 模式对每个 org 清单各跑一遍） */
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
  // ①' 反向对账（2026-10-10 任一侧关闭=完成）：已完结任务若标题带工单且工单仍 open → 补关
  try {
    const doneTasks = await listCompletedTasksWithIssue(ctx, listGuid);
    for (const t of doneTasks) {
      const ref = taskIssueRefFromSummary(t.summary);
      if (!ref) continue;
      const ir = await callGiteaApi(ctx, { method: "GET", path: `${issuesBaseFor(ref.repo)}/${ref.issueNo}` });
      const issue = ir.value?.data as { state?: string } | undefined;
      if (ir.ok && is2xx(ir.value?.status ?? 0) && (issue?.state ?? "open") === "open") {
        const note = await closeIssueForCompletedTask(ctx, t.summary, {
          reason: "对账发现任务已完结而工单未关",
          notifyChatId,
        }).catch(() => undefined);
        if (note) completionReports.push(note);
      }
    }
  } catch (e) {
    console.error(`[task-issue-sync] 反向对账失败(不阻断): ${String(e)}`);
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

    if (request.mode === "create-planned") {
      // 原语模式：飞书先行——建「计划中」任务挂 org 清单 P 分组（带 guid 回传 pipeline）
      const created = await createPlannedTask(ctx, {
        repo: request.repo,
        title: request.title,
        priority: request.priority,
        sourceChatId: request.sourceChatId,
        texts: request.texts,
        sources: request.sources,
      });
      return ok({
        response: created.ok ? `📋 ${created.detail}` : `⚠️ 计划任务创建未完成：${created.detail}`,
        ...(created.guid ? { taskGuid: created.guid } : {}),
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
    } else if (intent.kind === "confirm-pending") {
      response = handlePendingConfirm(intent.ref, sessionChatId, request.root_id);
    } else if (intent.kind === "pending-assign") {
      response = await handlePendingAssign(ctx, intent.ref, intent.repo, sessionChatId, request.root_id);
    } else if (intent.kind === "pending-skip") {
      response = handlePendingSkip(intent.ref, sessionChatId, request.root_id);
    } else if (intent.kind === "pending-batch") {
      // 多行/连写核验逐条落单；单条失败不阻断其余（结果逐条汇报）
      const parts: string[] = [];
      for (const item of intent.items) {
        if (item.action === "assign") {
          parts.push(await handlePendingAssign(ctx, item.ref, item.repo, sessionChatId, request.root_id));
        } else if (item.action === "confirm") {
          parts.push(handlePendingConfirm(item.ref, sessionChatId, request.root_id));
        } else if (item.action === "assign-executor") {
          parts.push(await handleAssignExecutor(ctx, item.ref, item.executor, request.root_id));
        } else {
          parts.push(handlePendingSkip(item.ref, sessionChatId, request.root_id));
        }
      }
      response = parts.join("\n\n");
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
