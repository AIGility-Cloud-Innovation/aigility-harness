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
import { readAgentDecision, writeDecision } from "./agent-decision.js";
import { worktreeDirName, worktreeRoot } from "./worktree-manager.js";
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
import { getIdentityRegistry, resolveMemberByName, findMemberByFeishuOpenId, identityMembers } from "./identity-registry.js";
// 项目小助理事件快照：建单/完成等显著变化 → 防抖后写入 timem（briefing-events 内部节流）
import { notifyRepoActivity } from "./briefing-events.js";
// agent 任务免工单链：台账登记/放行（worker-team 认领执行）。
// 注意：provider id 不从 feishu-task-provider import——该模块在模块求值期用本模块的
// SECTION_NAMES 构建 SECTION_TO_STATUS，反向 import 会成环导致投影表拿到 undefined。
import type { TaskRegistry } from "./task-registry.js";
import type { TaskRecord } from "@aigility-harness/core";

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
  /** 决策回复（耳朵，2026-10-19）：「决策 N/短码 选项」——needs-input 反问回收；
   *  编号=任务号尾段短码/uid/R 码，选项=序号或文字，省略=采用缺省项 */
  | { kind: "decision"; ref: string; option: string }
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
  | { kind: "help" }
  /** 手动对齐：「立即对齐」——不等整点，立刻跑一轮对齐器+状态队列（编排层钩子由 loop 装配） */
  | { kind: "align-now" };

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
  members?: TaskMemberLike[];
}

export interface IssueLike {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  body?: string;
  assignee?: { login?: string; username?: string };
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
  return explicit ?? process.env.GITEA_DEFAULT_REPO ?? "AIGility-Cloud-Innovation/aigility-harness";
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
  issue: IssueLike,
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
  // 执行者推导（2026-10-10 规则②）：入参 > 工单 assignee > 工单正文「执行者：」标记。
  // 执行者是人工任务铁证（护栏+plan-gate 双闸依据），必须写进任务描述。
  const executorInIssue =
    executor ??
    issue.assignee?.login ??
    issue.assignee?.username ??
    (typeof issue.body === "string"
      ? (issue.body.match(/执行者[:：]\s*(\S+)/)?.[1] as string | undefined)
      : undefined);
  const body: Record<string, unknown> = { summary: syncTaskSummary(repo, issue) };
  const descParts: string[] = [];
  if (issue.html_url) descParts.push(`工单链接：${issue.html_url}`);
  if (sourceChatId) descParts.push(`来源群：${await resolveChatName(ctx, sourceChatId)}`);
  // 执行者是 plan-gate 的 P→D 闸门依据（/执行者：\S+/）
  if (executorInIssue) descParts.push(`执行者：${executorInIssue}`);
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
  // 挂清单；执行人=负责人优先：工单带 assignee/正文标记 = 人工任务 → 建任务后设负责人挂 D；
  // 无执行人 → 挂 P 等执行人确认（2026-10-10 规则②：工单先行路径）
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
  // 落分组：工单带执行人 → 设负责人挂 D（人工任务）；无 → 挂 P 等执行人确认（2026-10-10 规则②）
  if (executorInIssue) {
    const secs = await ensureSections(ctx, list.guid);
    // 负责人 open_id：登记表名册反查（工单侧只有名字/login）
    const mem = identityMembers(getIdentityRegistry()).find(
      (m) => m.name === executorInIssue || m.gitea_usernames.includes(executorInIssue) || m.aliases.includes(executorInIssue),
    );
    const openId = mem?.feishu_open_ids[0];
    if (openId) {
      await callFeishuApi(ctx, {
        method: "POST",
        path: `/open-apis/task/v2/tasks/${taskGuid}/add_members`,
        query: { user_id_type: "open_id" },
        identity: "user",
        body: { members: [{ id: openId, role: "assignee", type: "user" }] },
      }).catch(() => undefined);
    }
    if (secs.doing) {
      await moveToSection(ctx, taskGuid, list.guid, secs.doing).catch(() => undefined);
    }
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
  descParts.push("状态：待确认仓库与执行者（两者齐备后自动创建 Gitea 工单）");
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
export const SECTION_NAMES = { plan: "P 计划中", doing: "D 执行中", check: "C 待测试", fix: "A 待修复", paused: "挂起" } as const;
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

/**
 * 摘除任务标题的【挂起】前缀（飞书 PATCH summary；失败不抛——挂起主状态在分组，
 * 标题清理是尽力而为的展示收尾）。
 */
async function stripPausedPrefix(ctx: SeamContext, taskGuid: string, summary: string): Promise<void> {
  const cleaned = summary.replace(/^【挂起】\s*/, "");
  if (cleaned === summary) return;
  await callFeishuApi(ctx, {
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${taskGuid}`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { update_fields: ["summary"], task: { summary: cleaned } },
  }).catch(() => undefined);
}

/**
 * 【挂起】→ 摘前缀 + 挪「挂起」分组（2026-10-22 用户拍板：标题带【挂起】自动挪组；
 * 分组即状态——用户自定义组被收编豁免（adoptUnsectionedTasks 只收真裸任务），
 * 状态靠分组不再靠标题，机器主动摘前缀防「标题脏 + 分组信号冗余」）。
 */
async function pauseBySection(
  ctx: SeamContext,
  taskGuid: string,
  summary: string,
  tasklistGuid: string,
  sections: Partial<Record<SectionKey, string>>,
): Promise<void> {
  await stripPausedPrefix(ctx, taskGuid, summary);
  const pausedGuid = sections.paused;
  if (pausedGuid) await moveToSection(ctx, taskGuid, tasklistGuid, pausedGuid);
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
): Promise<Array<{ guid?: string; task_id?: string; summary?: string; description?: string; url?: string; members?: TaskMemberLike[]; created_at?: string | number }>> {
  // 注意：query 里不能带 completed=false —— 实测（2026-10-10）当前租户带该参数恒返回空列表；
  // 改为不过滤拉全量，再按 completed_at 代码内过滤（completed_at>0 = 已完成）
  const r = await callFeishuApi(ctx, {
    method: "GET",
    path: `/open-apis/task/v2/sections/${sectionGuid}/tasks`,
    query: { page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  if (!r.ok || (r.value?.code ?? -1) !== 0) return [];
  const items = (r.value?.data as {
    items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string; url?: string; members?: TaskMemberLike[]; completed_at?: string | number; created_at?: string | number }>;
  })?.items ?? [];
  return items.filter((t) => !t.completed_at || Number(t.completed_at) === 0) as Array<{ guid?: string; task_id?: string; summary?: string; description?: string; url?: string; members?: TaskMemberLike[]; created_at?: string | number }>;
}

/** 飞书任务成员形状（task members[]） */
export interface TaskMemberLike {
  id?: string;
  role?: string;
  type?: string;
}

/** 标题前缀标签链摘除【待安排执行者】（可在链中任意位置，如【待确认仓库】之后；非前缀链内不动）。
 *  2026-10-23 摘牌规则用：执行人已定的任务不再挂「待安排执行者」。 */
export function stripPendingExecutorTag(summary: string): string {
  const chain = summary.match(/^(?:【[^】]*】)*/)?.[0] ?? "";
  if (!chain.includes("【待安排执行者】")) return summary;
  return chain.replace("【待安排执行者】", "") + summary.slice(chain.length);
}

/** 闸门标签常量（2026-10-23 更名：归属→仓库）。历史别名一并识别防连环叠标。 */
export const GATE_TAG_REPO = "待确认仓库";
/** 历史别名（2026-10-23 前的旧名，存量卡与旧代码写入残留） */
export const GATE_TAG_REPO_LEGACY = "待确认归属";
export const GATE_TAG_EXEC = "待安排执行者";
const ALL_GATE_TAGS = [GATE_TAG_REPO, GATE_TAG_REPO_LEGACY, GATE_TAG_EXEC] as const;

/** 从前缀标签链中摘掉所有闸门标签，保留其余业务标签（如【重要】）原样。 */
function withoutGateTags(chainText: string): string {
  return ALL_GATE_TAGS.reduce((acc, tag) => acc.split(`【${tag}】`).join(""), chainText);
}

/**
 * 标题闸门标签链归一化：把前缀【…】链内的闸门标签收敛为规范形。
 * 修复 2026-10-23 严重缺陷「P 任务被连续叠加【待确认归属/仓库】」：
 * 旧实现只剥链首（/^【待确认仓库】/），遇到旧名【待确认归属】开头或多标签链
 * 剥不到 → 每拍在链首再叠一个新标签（现网 ×7 连环即此）。
 * 2026-10-25 用户拍板：闸门改为「先执行人、后仓库」两段式，两个标签互斥。
 * 规则：链内所有闸门标签（新旧名+执行者）收敛至多 1 个；同时存在时保留
 * 【待安排执行者】（执行人闸门在前，缺执行人的任务优先被识别），正文原样保留；
 * 链外（正文内）出现的同名文本不动。
 */
export function normalizeGateTags(summary: string): string {
  const m = summary.match(/^((?:【[^】]*】)*)([\s\S]*)$/);
  if (!m) return summary;
  const chainText = m[1] ?? "";
  const body = m[2] ?? "";
  const hasRepo = chainText.includes(`【${GATE_TAG_REPO}】`) || chainText.includes(`【${GATE_TAG_REPO_LEGACY}】`);
  const hasExec = chainText.includes(`【${GATE_TAG_EXEC}】`);
  // 互斥：执行者标签优先（缺执行人是更前置的闸门），绝不同时挂两个标签；其余业务标签保留。
  const next =
    (hasExec ? `【${GATE_TAG_EXEC}】` : hasRepo ? `【${GATE_TAG_REPO}】` : "") +
    withoutGateTags(chainText);
  if (chainText === next) return summary;
  return next + body;
}

/** 摘除执行者闸门标签 + 其余标签归一化（执行人已定时的摘牌用；仓库旧名一并转新名）。 */
export function stripExecutorTagNormalized(summary: string): string {
  const m = summary.match(/^((?:【[^】]*】)*)([\s\S]*)$/);
  if (!m) return summary;
  const chainText = m[1] ?? "";
  const body = m[2] ?? "";
  const hasRepo = chainText.includes(`【${GATE_TAG_REPO}】`) || chainText.includes(`【${GATE_TAG_REPO_LEGACY}】`);
  const next = (hasRepo ? `【${GATE_TAG_REPO}】` : "") + withoutGateTags(chainText);
  if (chainText === next) return summary;
  return next + body;
}

/** 摘除仓库闸门标签 + 其余标签归一化（真人负责人已定时用：仓库由执行人自定，不再等确认）。 */
export function stripRepoTagNormalized(summary: string): string {
  const m = summary.match(/^((?:【[^】]*】)*)([\s\S]*)$/);
  if (!m) return summary;
  const chainText = m[1] ?? "";
  const body = m[2] ?? "";
  const hasExec = chainText.includes(`【${GATE_TAG_EXEC}】`);
  const next = (hasExec ? `【${GATE_TAG_EXEC}】` : "") + withoutGateTags(chainText);
  if (chainText === next) return summary;
  return next + body;
}

/** 提取飞书任务的负责人（members[].role === "assignee" → 名册成员名或 open_id）。
 *  负责人=执行人=人工任务铁证：带负责人的 D 组任务绝不派 agent（2026-10-10 用户铁律）。
 *  执行人写在飞书任务的「负责人」字段（成员），不是任务描述。 */
export function assigneeFromTask(
  task: { members?: TaskMemberLike[] } | undefined,
): string | undefined {
  const m = (task?.members ?? []).find((x) => x.role === "assignee" && x.id);
  if (!m?.id) return undefined;
  const member = findMemberByFeishuOpenId(getIdentityRegistry(), m.id);
  return member?.name ?? m.id;
}

/** 统一执行人判定：负责人（members assignee）永远优先——有负责人=人工任务，
 *  以负责人名字为准（2026-10-20 拍板：标题【agent】前缀也不推翻负责人）；其次台账结构化
 *  负责人 assignee_member_id（①.2 反向同步落库的体外负责人）；再次描述「执行者：」人名标记。
 *  「agent/agentd」不是人名：描述标记 agent 值一律返回 undefined（agent 判定已收敛为
 *  只看标题【agent】前缀，2026-10-20 拍板，描述不再参与识别）。
 *  派发护栏、plan-gate 闸门、双建落组共用此判定（判定源一致，行为才一致）。 */
/** 剥掉 【agent】/[org/repo] 等结构前缀，返回核心任务描述 */
function cleanSummary(s: string): string {
  return s.replace(/^【[^】]*】\s*/, "").replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function executorOfTask(
  task: { members?: TaskMemberLike[]; description?: string; assignee_member_id?: string } | undefined,
): string | undefined {
  const byAssignee = assigneeFromTask(task);
  if (byAssignee) return byAssignee;
  if (task?.assignee_member_id) {
    const m = identityMembers(getIdentityRegistry()).find((x) => x.member_id === task.assignee_member_id);
    if (m) return m.name;
    return task.assignee_member_id;
  }
  // 捕获到空白/中文或半角标点/右括号即停：任务描述常写成「【执行者：agent】目标xx」，
  // 旧 \S+ 会把「agent】目标xx」整段吞成执行人名，导致 agent 任务被误判为人工任务。
  const md = (task?.description ?? "").match(/执行者[:：]\s*([^\s，,。；;】）)\]]+)/);
  const marked = md ? md[1] : undefined;
  if (marked && /^agent/i.test(marked)) return undefined; // agent/agentd 非人名（历史误写一并吞掉）
  return marked;
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

/** 飞书先行任务标题 [org/repo] 前缀（归属已确认标记）→ 仓库 full_name（解析不出 undefined）
 *  2026-10-20：兼容 [org/repo#N]（工单号保留在标题，不剥）与任意【…】前缀（如【agent】）。 */
export function repoFromPlannedSummary(summary: string | undefined): string | undefined {
  const m = (summary ?? "").match(/^(?:【[^】]*】\s*)*\[([^\]#/]+)\/([^\]#/]+)(?:#\d+)?\]/);
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

  // ② 建任务：sourceMessageId=issue:{repo}#{n}（确定性映射，零存储防重）。
  // agentd 异常（socket 抖动/未启动）不炸扫描拍：捕获后报错留 D 下轮重试。
  const prompt = buildDispatchPrompt(repo, issue);
  let taskId = "";
  let created: Awaited<ReturnType<typeof agentdCreateFromMessage>> | undefined;
  try {
    created = await agentdCreateFromMessage(endpoint, {
      source: "harness-dispatch",
      sourceMessageId: `issue:${repo}#${issueNo}`,
      sourceConversationId: notifyChatId ?? "",
      title: `#${issueNo} ${issue.title?.trim() ?? ""}`.slice(0, 80),
      description: prompt,
      text: prompt,
    });
    taskId = created.id ?? created.taskId ?? "";
  } catch (e) {
    return `❌ 派发失败（工单 #${issueNo}）：agentd 不可达 ${String((e as Error)?.message ?? e).slice(0, 80)}，留 D 下轮重试。`;
  }
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
  // 防误接（2026-10-21 拍板 ④）：派发即工单评论「施工中」，执行期全程有动态标记（失败不阻断派发）
  await callGiteaApi(ctx, {
    method: "POST",
    path: `${issuesBaseFor(repo)}/${issueNo}/comments`,
    body: { body: `🤖 **已派发 agent 执行中**（agentd 任务 \`${taskId}\`）。\n确认闸门 ${mins} 分钟：回复「取消派发 #${issueNo}」可撤销，超时自动执行。真人请勿认领。` },
  }).catch(() => undefined);
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
  inflight: Map<string, { repo: string; issueNo: number; tasklistGuid: string; feishuTaskGuid?: string; startedAnnounced?: boolean }>;
}

const dispatchRuntime: DispatchRuntime = { timer: null, inflight: new Map() };

// ── agent 任务免工单链（2026-10-13 拍板）─────────────────────────
/** plan-gate 用的登记表（bootstrap 注入 getSharedRegistry()；未注入时 agent 任务留 P 并提示） */
let planGateRegistry: TaskRegistry | undefined;
/** 注入登记表（装配层启动时调用一次） */
export function setPlanGateRegistry(registry: TaskRegistry): void {
  planGateRegistry = registry;
}

// ── 决策回复（耳朵，2026-10-19）：「决策 任务号 选项」回收 needs-input 反问 ──────────
let decisionNotifySend: ((text: string) => Promise<void> | void) | undefined;
/** 注入决策回执发送函数（装配层启动时调用一次；未注入仅台账生效不播报） */
export function setDecisionNotifySend(send: (text: string) => Promise<void> | void): void {
  decisionNotifySend = send;
}

/** 决策回执播报（尽力而为：通知失败不影响决策落地） */
function sendDecisionNotice(text: string): void {
  try {
    void decisionNotifySend?.(text);
  } catch {
    // 忽略通知异常
  }
}

/** 决策 cwd 定位：与 worker-team 决策续跑同逻辑（worktree 优先，回退主仓库根 ~/AI/<短名>） */
function decisionCwdOf(task: TaskRecord): string | undefined {
  const short = task.projectRef?.split("/").pop();
  if (!short) return undefined;
  const repoRoot = join(homedir(), "AI", short);
  const wt = join(worktreeRoot(), worktreeDirName(repoRoot, task.uid));
  if (existsSync(wt)) return wt;
  return repoRoot;
}

/**
 * 决策回复寻任务（2026-10-22 抽出可测）：尾码(≥4字符)/uid/全号精确匹配；
 * 播报教的「决策 1 <选项>」短序号仅在唯一待决策任务时对号（多任务时序号
 * 在各条播报里都是 1，无区分度，须用尾码）。
 * 「决策 N/短码 选项」整体流程：定位 needs-input 任务 → 按决策文件选项解析回复 →
 * writeDecision → reenqueueNeedsInput（needs-input→ready）→ worker-team 原线程续跑。
 */
export function resolveWaitingDecisionTask<T extends { uid: string }>(
  waiting: T[],
  token: string,
): T | undefined {
  const t = token.replace(/^#/, "").trim();
  let task = waiting.find((x) => x.uid === t || x.uid === `tsk_${t}`);
  if (!task && t.length >= 4) task = waiting.find((x) => x.uid.endsWith(t));
  if (!task && /^\d{1,2}$/.test(t) && waiting.length === 1) task = waiting[0];
  return task;
}

async function handleDecision(ref: string, option: string): Promise<string> {
  const reg = planGateRegistry;
  if (!reg) return "⚠️ 决策通道未就绪（台账未注入），请稍后重试。";
  const waiting = reg.list({ status: ["needs-input"] });
  const task = resolveWaitingDecisionTask(waiting, ref);
  if (!task) {
    if (waiting.length === 0) return "（当前没有等待决策的任务）";
    const rows = waiting.map((t) => `  · ${t.uid.slice(-6)} ${t.title ?? ""}`).join("\n");
    const shortHint = waiting.length === 1 ? "\n（当前仅这一个待决策任务，也可回复「决策 1 <选项序号/文字>」）" : "";
    return `❓ 没找到任务「${ref}」或它不在等待决策中。当前待决策：\n${rows}${shortHint}\n回复「决策 任务号尾6位 选项序号/文字」`;
  }
  const cwd = decisionCwdOf(task);
  if (!cwd) return `❓ ${task.uid.slice(-6)}「${task.title}」未关联仓库，无法定位决策文件。`;
  const chk = readAgentDecision(cwd);
  if (!chk.found) return `❓ ${task.uid.slice(-6)} 当前没有待决策的决策文件（可能已处理）。`;
  if (chk.invalid || !chk.decision) return `⚠️ ${task.uid.slice(-6)} 决策文件格式非法，请人工处理。`;
  if (chk.decision.decision) {
    return `ℹ️ ${task.uid.slice(-6)} 决策已完成（「${chk.decision.decision}」），请勿重复提交。`;
  }
  let decisionText = option.trim();
  if (/^\d+$/.test(decisionText)) {
    const opts = chk.decision?.options ?? [];
    const idx = Number.parseInt(decisionText, 10) - 1;
    if (opts.length === 0) {
      decisionText = `选项${decisionText}`;
    } else if (idx < 0 || idx >= opts.length) {
      const menu = opts.map((o, i) => `${i + 1}.${o}`).join("  ");
      return `❓ 选项序号超出范围（1-${opts.length}）：${menu}`;
    } else {
      decisionText = opts[idx];
    }
  } else if (!decisionText) {
    const opts = chk.decision?.options ?? [];
    const def = chk.decision?.defaultOption ?? 0;
    decisionText = opts[def] ?? opts[0] ?? "";
    if (!decisionText) return "❓ 决策点没有可用的缺省项，请回复选项序号或文字。";
  }
  const decidedFrom = `决策 ${ref} ${option}`.trim();
  const w = writeDecision(cwd, decisionText, {
    decidedBy: "用户（飞书「决策」指令）",
    decidedFrom,
  });
  if (!w.ok) return `⚠️ 决策写入失败：${w.error}`;
  const r = reg.reenqueueNeedsInput(task.uid);
  if (!r.ok) {
    writeDecision(cwd, chk.decision.decision ?? "");
    return `⚠️ 决策重入队失败：${"error" in r ? r.error : "未知错误"}，未生效请重新回复。`;
  }
  const msg = `✅ 已按「${decisionText}」决策，${task.uid.slice(-6)}「${(task.title ?? "").slice(0, 40)}」重新入队，工人将自动续跑。`;
  sendDecisionNotice(msg);
  return msg;
}
/** agent 任务放行回执防重（同任务只报一次，节拍重复扫不刷屏） */
const agentReleasedReported = new Set<string>();
/** agent 任务来源 provider（字面量与 feishu-task-provider 的 FEISHU_TASK_PROVIDER_ID 同值，防环不引） */
const FEISHU_TASK_PROVIDER = "feishu-task";

/**
 * 收编裸任务（飞书任务为先行主源）：清单里不在 P/D/C/A 任何分组的未完成任务
 * （成员直接在清单里手工建的）→ 自动挪入「P 计划中」，进入统一闸门。
 * 返回收编任务名（含 guid 尾码兜底）——播报要点明对象（2026-10-22 用户反馈）。
 */
export async function adoptUnsectionedTasks(
  ctx: SeamContext,
  tasklistGuid: string,
): Promise<string[]> {
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
    // 不带 completed 参数（实测恒空列表），代码内按 completed_at 过滤
    query: { page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  if (!fr.ok || (fr.value?.code ?? -1) !== 0) return [];
  const all = (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; completed_at?: string | number }> })?.items ?? [];
  const adopted: string[] = [];
  for (const t of all) {
    if (t.completed_at && Number(t.completed_at) !== 0) continue; // 已完成
    const g = t.guid ?? t.task_id;
    if (!g || sectioned.has(g)) continue;
    const planGuid = sections.plan;
    if (planGuid && (await moveToSection(ctx, g, tasklistGuid, planGuid))) {
      // 点明收编对象（2026-10-22 用户反馈：「检测到 1 条」看不出是哪条）
      adopted.push(t.summary?.replace(/\s+/g, " ").slice(0, 30) ?? g.slice(-6));
    }
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
    // 无默认仓库机制（2026-10-13 拍板）：解析不出仓库跳过（任务标题残缺，等人工补正）
    if (!repoMatch) continue;
    const repo = `${repoMatch[1]}/${repoMatch[2]}`;
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

/** 手动对齐钩子（装配层 set；loop 把 aligner.runOnce+状态队列一拍接进来） */
let manualAlignHook: (() => Promise<string>) | undefined;
export function setManualAlignHook(fn: (() => Promise<string>) | undefined): void {
  manualAlignHook = fn;
}

/** 执行手动对齐：钩子未装配（编排层单测/独立运行）返回说明文本 */
async function runManualAlign(): Promise<string> {
  if (!manualAlignHook) return "对齐调度器未装配（运行时由小助理进程注入），请稍后再试。";
  try {
    return await manualAlignHook();
  } catch (e) {
    return `❌ 手动对齐失败：${String((e as Error)?.message ?? e)}`;
  }
}

async function dispatchNotify(chatId: string | undefined, text: string): Promise<void> {
  if (!chatId || !dispatchNotifySend) return;
  try {
    await dispatchNotifySend(chatId, text);
  } catch (e) {
    console.error(`[task-issue-sync] dispatch notify failed: ${String(e)}`);
  }
}

/** 「pipeline/agent」标签 id（每仓 memo）：确保标签存在并取 id，失败返回 undefined（不阻断建单） */
const pipelineLabelIds = new Map<string, number | undefined>();
async function ensurePipelineLabelId(ctx: SeamContext, repo: string): Promise<number | undefined> {
  if (pipelineLabelIds.has(repo)) return pipelineLabelIds.get(repo);
  let id: number | undefined;
  try {
    const labelsBase = issuesBaseFor(repo).replace(/\/issues$/, "/labels");
    const lr = await callGiteaApi(ctx, { method: "GET", path: labelsBase, query: { limit: 50 } });
    const found = ((lr.value?.data as { id: number; name: string }[]) ?? []).find((l) => l.name === "pipeline/agent");
    if (found) id = found.id;
    else {
      const cr = await callGiteaApi(ctx, {
        method: "POST",
        path: labelsBase,
        body: { name: "pipeline/agent", color: "#fbca04", description: "流水线自动创建，agent 派发执行中，请勿认领" },
      });
      if (cr.ok && is2xx(cr.value?.status ?? 0)) id = (cr.value?.data as { id?: number })?.id;
    }
  } catch {
    /* 标签不可用不阻断建单 */
  }
  pipelineLabelIds.set(repo, id);
  return id;
}

/** 建单防误接声明（2026-10-21 拍板 ①+②）：正文头部醒目警告，压低真人误接单概率 */
function pipelineIssueBanner(): string {
  return "⚠️ **流水线自动创建**：本单将由 agent 自动派发执行中，请勿认领。人工终止请回复「取消派发 #编号」。";
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

  // 现有 open 工单标题（去重基准；阈值与 pipeline 一致 0.5）。
  // 2026-10-21 事故修复：去重基准必须与建单仓库一致——原先固定查 GITEA_DEFAULT_REPO，
  // 而回填建单走标题解析仓库，两库不同时查重恒空 → 同一源卡每拍重复建单（#152~#261 连环 110 张）。
  // 改为按仓库懒加载 memo（每轮每仓库至多一次 GET）。
  // 归属自动补齐（2026-10-22 拍板）白名单：登记表全部 gitea_repos（只认登记过的仓库，
  // 防描述随手写的任意字符串被当归属）。
  const knownOrgRepos = getProjectRegistry().projects.flatMap((p) => p.gitea_repos ?? []);
  const threshold = opts.threshold ?? 0.5;
  const openIssueTitlesByRepo = new Map<string, string[]>();
  const openIssueTitles = async (repo?: string): Promise<string[]> => {
    const key = repo ?? "__default__";
    if (!openIssueTitlesByRepo.has(key)) {
      const dr = await callGiteaApi(ctx, {
        method: "GET",
        path: issuesBaseFor(repo),
        query: { state: "open", limit: 50, type: "issues" },
      });
      const titles: string[] = [];
      if (dr.ok && is2xx(dr.value?.status ?? 0)) {
        for (const it of (dr.value?.data as IssueLike[]) ?? []) {
          if (it.title) titles.push(it.title);
        }
      }
      openIssueTitlesByRepo.set(key, titles);
    }
    return openIssueTitlesByRepo.get(key)!;
  };

  for (const t of planTasks) {
    const guid = t.guid ?? t.task_id ?? "";
    const summary = t.summary ?? "";
    if (!guid) continue;
    const issueNo = issueNumberFromTaskSummary(summary);
    // 【挂起】处理（2026-10-13 硬跳过 → 2026-10-22 拍板升级）：标题【挂起】自动挪
    // 「挂起」分组并摘前缀；分组即状态（用户自定义组收编豁免，不会被拉回 P）。
    if (summary.includes("【挂起】")) {
      await pauseBySection(ctx, guid, summary, opts.tasklistGuid, sections);
      continue;
    }
    // 自动挂起（2026-10-23 用户拍板方案A）：静默收集的任务在 P 滞留超 7 天未确认
    // → 挪「挂起」组（不删，可恢复），周播报汇总提示可回复恢复。created_at 缺失跳过不猜。
    const createdAtMs = Number(t.created_at ?? 0);
    if (createdAtMs > 0 && Date.now() - createdAtMs > 7 * 24 * 3600 * 1000) {
      await pauseBySection(ctx, guid, summary, opts.tasklistGuid, sections);
      reports.push(`⏸️ 「${summary.replace(/^【[^】]*】\s*/, "").slice(0, 36)}」P 滞留超 7 天，自动挂起。群里回复「恢复任务」可重新拉回 P。`);
      continue;
    }
    // 前缀仓库校验+近似纠正（2026-10-22 t102051 事故）：手写错名前缀（如
    // [timem-console-frontend]，真名 TiMEM-AI/timem_console_frontend）解析不出
    // projectRef → 派发反复失败、永久滞留 P。归一化（小写、-/_ 等价、单名自动配
    // 唯一 org）命中登记表 → 机器改写为登记全名并播报；命中不了不动（交后续闸门）。
    const prefixRepo = summary.match(/^\[([^\]]+)\]/)?.[1];
    if (prefixRepo && !knownOrgRepos.includes(prefixRepo)) {
      const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
      const repoPartHits = knownOrgRepos.filter((r) => norm(r.split("/")[1] ?? "") === norm(prefixRepo));
      const target =
        knownOrgRepos.find((r) => norm(r) === norm(prefixRepo)) ??
        (repoPartHits.length === 1 ? repoPartHits[0] : undefined);
      if (target) {
        const newSummary = `[${target}] ${summary.replace(/^\[[^\]]+\]\s*/, "")}`;
        await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { update_fields: ["summary"], task: { summary: newSummary } },
        }).catch(() => undefined);
        reports.push(`🏷️ 仓库前缀已校正：${prefixRepo} → ${target}（如不对请改标题）。`);
        continue; // 下一拍按纠正后的正常流程走
      }
    }
    // 列表端点不返回 description（2026-10-13 实测：17 个任务全部为空）：对空描述做
    // 单任务 GET 补全量，否则执行人闸门/LLM 要素核对/agent 任务检测全部因空描述失判。
    if (!t.description) {
      const d = await callFeishuApi(ctx, {
        method: "GET",
        path: `/open-apis/task/v2/tasks/${guid}`,
        query: { user_id_type: "open_id" },
        identity: "user",
      }).catch(() => undefined);
      t.description =
        (d?.ok ? (d.value?.data as { task?: { description?: string } } | undefined)?.task?.description : undefined) ?? "";
    }

    // ① 去重：与标题解析仓库的 open 工单 Jaccard 相似（仓库解析不出则交给归属闸门，不在此查重）。
    // 2026-10-21 事故修复：命中 → 打【疑似重复】标（幂等，只报一次）并 continue——
    // 打过标的卡仍参与查重（标题尾部加标对字符二元组相似度影响 <0.05，恒命中），绝不落到建单分支。
    if (issueNo === undefined) {
      const ownRepo = repoFromPlannedSummary(summary);
      if (ownRepo) {
        const dupHit = (await openIssueTitles(ownRepo)).find(
          (title) => jaccard(title, summary.replace(/^\[[^\]]+\]\s*/, "")) >= threshold,
        );
        if (dupHit) {
          const alreadyTagged = summary.includes("【疑似重复】");
          if (!alreadyTagged) {
            await callFeishuApi(ctx, {
              method: "PATCH",
              path: `/open-apis/task/v2/tasks/${guid}`,
              query: { user_id_type: "open_id" },
              identity: "user",
              body: { update_fields: ["summary"], task: { summary: `${summary}【疑似重复】` } },
            }).catch(() => undefined);
            reports.push(`🧹 「${summary.slice(0, 40)}」与现有工单「${dupHit.slice(0, 40)}」疑似重复，已打标留 P 待人工处理。`);
          }
          continue;
        }
      }
    }

    // ⓪ 执行人确认闸门（先于回填建单，2026-10-10 规则①：确定好执行人才能建单）：
    // 负责人=人工执行（永远优先，2026-10-20 拍板：以负责人名字为准）；无负责人且
    // 标题带【agent】前缀 = agent 执行（描述「执行者：」不再参与 agent 识别）；两者皆无 = 未定，留 P
    const humanExecutor = executorOfTask(t);
    // 【agent】标题前缀=agent 任务唯一认定（2026-10-20 拍板收敛）。对齐器可能已在标题前
    // 打过【待安排执行者】/【待确认仓库】闸门标签（先于本约定运行的历史轮次），匹配前先剥掉；
    // [org/repo] 前缀与【agent】顺序不限（先剥归属闸门标签、再剥仓库前缀后测试 agent 标记）。
    const bareSummary = summary
      .replace(/^【(待安排执行者|待确认仓库)】/, "")
      .replace(/^\[[^\]#]+\/[^\]#]+(?:#\d+)?\]\s*/, "");
    const agentDecided = /^【agent】/.test(bareSummary);
    if (!humanExecutor && !agentDecided) {
      // 2026-10-25 两段式闸门第一段：缺执行人 → 只挂【待安排执行者】（与仓库标签互斥，
      // 历史轮次留下的【待确认仓库】一并摘除），先让群里有明确的人可安排。
      const tagged = normalizeGateTags(`【${GATE_TAG_EXEC}】${summary}`);
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
      reports.push(`👤 「${summary.slice(0, 40)}」尚未安排执行者，留 P。群里回复「执行者 ${issueNo !== undefined ? `#${issueNo}` : "编号"} @人名」后自动进入执行。`);
      continue;
    }
    // ⓪-前置摘牌（2026-10-23 用户拍板：负责人已有人名的任务不再挂【待安排执行者】）：
    // 执行人已定（负责人/agent）而标题仍带历史轮次的闸门标签 → 摘除（可能在【待确认仓库】等
    // 标签之后，非开头），防「已定执行人却显示待安排」。
    if (summary.includes("【待安排执行者】")) {
      const cleaned = stripExecutorTagNormalized(summary);
      if (cleaned !== summary) {
        await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { update_fields: ["summary"], task: { summary: cleaned } },
        }).catch(() => undefined);
        reports.push(`🏷️ 「${cleaned.slice(0, 40)}」已有执行人，摘除【待安排执行者】标签。`);
      }
    }

    // 两段式闸门第二段的前置判定（2026-10-25 用户拍板：先确认执行人，再确认仓库）：
    // 执行人已明确时仓库由执行人自己定，不再等负责人指定；负责人（assignee）已是真人
    // = 执行人明确，仓库缺失也不打【待确认仓库】（真人任务不需要等仓库确认）。
    // 只有「执行人靠描述/agent 认定、且标题与描述都推断不出仓库」才需要确认仓库。
    const hasHumanAssignee = Boolean(assigneeFromTask(t));
    const repoInDescription = (t.description ?? "").match(/([A-Za-z][\w.-]*\/[\w.-]+)(?:\.git)?/)?.[1];
    const inferredRepoFromDescription =
      repoInDescription && knownOrgRepos?.includes(repoInDescription) ? repoInDescription : undefined;
    const repoKnownForBackfill = Boolean(repoFromPlannedSummary(summary) ?? inferredRepoFromDescription);
    // 执行人已定且仓库可推断（标题 [org/repo#N] 或描述登记仓库）= 两段式闸门已满足。
    // 真人负责人即使仓库未知也无需确认仓库（由执行人自定）；其余执行人必须仓库可推断，
    // 历史轮次的【待确认仓库】才摘除，避免带标卡进入 D 后被 dispatch-scan 当闸门卡静默跳过。
    const executorDecided = humanExecutor !== undefined || agentDecided;
    const repoGateObsolete = hasHumanAssignee || (executorDecided && repoKnownForBackfill);
    if (
      repoGateObsolete &&
      (summary.includes("【待确认仓库】") || summary.includes("【待确认归属】"))
    ) {
      const cleaned = stripRepoTagNormalized(stripExecutorTagNormalized(summary));
      if (cleaned !== summary) {
        await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { update_fields: ["summary"], task: { summary: cleaned } },
        }).catch(() => undefined);
        reports.push(
          hasHumanAssignee
            ? `🏷️ 「${cleaned.slice(0, 40)}」已有真人执行人，摘除【待确认仓库】标签。`
            : `🏷️ 「${cleaned.slice(0, 40)}」已有执行人且仓库已明确，摘除【待确认仓库】标签。`,
        );
      }
    }

    // ⓪-a 先行任务回填工单（归属+执行者齐备才建）：没有 #N 的 P 任务，标题带
    // [org/repo] 前缀（归属已确认）→ 从标题解析仓库自动建 Gitea 工单并同步回写 #N；
    // 缺前缀且无法从描述推断 = 归属未确认 → 打【待确认仓库】留 P，等群里「任务归属」确认。
    // 真人负责人（assignee 有值）不受仓库闸门拦截：无仓库直接进入目标核对，任务留给人处理。
    // agent 任务（标题【agent】前缀认定，2026-10-20 拍板收敛：描述不再参与识别；免工单模式，产出=开启的 PR）
    // 跳过回填，落到下方 ready 分支走台账放行。
    if (
      issueNo === undefined &&
      !summary.includes("【待补充】") &&
      !agentDecided &&
      (!hasHumanAssignee || repoKnownForBackfill)
    ) {
      const prefix = summary.match(/^\[([^\]]+)\]/);
      if (!prefix) {
        // 归属自动补齐（2026-10-22 用户拍板：信息不全仅此项机器推断，执行人仍必问人）——
        // 描述里出现登记过的 org/仓库全名 → 直接写进标题前缀，不再等群里回复。
        const inferred = inferredRepoFromDescription;
        if (inferred) {
          const newSummary = `[${inferred}] ${summary.replace(/^(?:【[^】]*】\s*)*/, "")}`;
          await callFeishuApi(ctx, {
            method: "PATCH",
            path: `/open-apis/task/v2/tasks/${guid}`,
            query: { user_id_type: "open_id" },
            identity: "user",
            body: { update_fields: ["summary"], task: { summary: newSummary } },
          }).catch(() => undefined);
          reports.push(`🏷️ 「${summary.slice(0, 40)}」归属按描述自动判定为 ${inferred}（下一拍回填工单）。如不对请改标题。`);
          continue;
        }
        const tagged = normalizeGateTags(`【${GATE_TAG_REPO}】${stripExecutorTagNormalized(summary)}`);
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
      // 前缀解析仓库：含 / 取 org/仓库。2026-10-13 拍板：无默认仓库机制——
      // 解析不出仓库不建单，留 P 提示确认归属（与归属确认同一交互）。
      const parsedRepo = repoFromPlannedSummary(summary);
      if (!parsedRepo) {
        const tagged = normalizeGateTags(`【${GATE_TAG_REPO}】${stripExecutorTagNormalized(summary)}`);
        if (tagged !== summary) {
          await callFeishuApi(ctx, {
            method: "PATCH",
            path: `/open-apis/task/v2/tasks/${guid}`,
            query: { user_id_type: "open_id" },
            identity: "user",
            body: { update_fields: ["summary"], task: { summary: tagged } },
          }).catch(() => undefined);
        }
        reports.push(`🏷️ 「${summary.slice(0, 40)}」标题前缀解析不出仓库，留 P。群里回复「任务归属 编号 @仓库」确认后自动创建工单。`);
        continue;
      }
      const repo = parsedRepo;
      const cleanTitle = summary
        .replace(/^(?:【[^】]*】\s*)+/, "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .trim();
      // 工单描述带飞书任务链接 + 飞书负责人 → 工单指派人（2026-10-13 用户需求）：
      // 双向互链闭环（此前只有「工单链接→飞书描述」单向）；负责人经名册 open_id → gitea_username。
      const feishuTaskUrl = t.url ?? `https://www.feishu.cn/task/${guid}`;
      const assigneeOpenId = (t.members ?? []).find((x) => x.role === "assignee" && x.id)?.id;
      const assigneeGitea = assigneeOpenId
        ? findMemberByFeishuOpenId(getIdentityRegistry(), assigneeOpenId)?.gitea_usernames[0]
        : undefined;
      // 防误接（2026-10-21 拍板 ①+②）：无真人负责（将由 agent 派发）的单挂 pipeline/agent
      // 标签 + 正文头声明；带真人 assignee 的人工单不挂（assignee 本身即归属信号）。
      const labelId = assigneeGitea ? undefined : await ensurePipelineLabelId(ctx, repo);
      const ir = await callGiteaApi(ctx, {
        method: "POST",
        path: issuesBaseFor(repo),
        body: {
          title: cleanTitle,
          ...(assigneeGitea ? { assignees: [assigneeGitea] } : {}),
          ...(labelId !== undefined ? { labels: [labelId] } : {}),
          body: `${assigneeGitea ? "" : `${pipelineIssueBanner()}\n\n`}> 来源：飞书任务（归属+执行者已确认，由项目小助理回填工单）\n>\n> 飞书任务：${summary.slice(0, 80)}\n> 任务链接：${feishuTaskUrl}${assigneeGitea ? `\n> 负责人：@${assigneeGitea}` : ""}`,
        },
      });
      if (ir.ok && is2xx(ir.value?.status ?? 0)) {
        const issue = ir.value?.data as { number?: number; html_url?: string };
        // 收敛动作（2026-10-21 事故环3修复，方案 a）：#N 回写源卡标题（[repo#N] 形态，
        // issueNumberFromTaskSummary 下拍即识别 → 不再进本分支重复建单），工单链接补进描述；
        // 源卡自身即任务载体，不再另建镜像卡（镜像与源卡并存曾致同题双卡 + 永不收敛循环）。
        const backfill = `[${repo}#${issue.number}] ${cleanTitle}`;
        const pr = await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: {
            update_fields: issue.html_url ? ["summary", "description"] : ["summary"],
            task: {
              summary: backfill,
              ...(issue.html_url
                ? { description: [t.description, `工单链接：${issue.html_url}`].filter(Boolean).join("\n") }
                : {}),
            },
          },
        });
        const writeBackOk = pr.ok && (pr.value?.code ?? -1) === 0;
        reports.push(
          writeBackOk
            ? `🔗 「${cleanTitle.slice(0, 40)}」已回填工单 ${repo}#${issue.number}（#N 已写回源卡，收敛），可「确认派发 #${issue.number}」。`
            : `⚠️ 「${cleanTitle.slice(0, 40)}」工单 ${repo}#${issue.number} 已建但源卡回写失败：${pr.ok ? pr.value?.msg : pr.error}——请人工把 #${issue.number} 补进卡标题，否则下轮会重复建单。`,
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
      // ③ 完备 → agent 任务免工单：不挪 D（对齐器 D 投影=dispatched 会抢态），
      // 台账 adopt+approve 放行 ready 交工人小组（worker-team）认领执行；
      // 飞书任务留在 P 组防重复处理，产出=工人开的 Gitea PR（描述已带交付要求）。
      if (humanExecutor === undefined && agentDecided) {
        const reg = planGateRegistry;
        if (!reg) {
          reports.push(`⚠️ 「${summary.slice(0, 40)}」agent 任务未接登记表（setPlanGateRegistry 未注入），留 P。`);
          continue;
        }
        // 【agent】标题任务必须能定位仓库（2026-10-13 拍板：无默认仓库机制）：
        // 无 [org/repo] 前缀 → 留 P 提示补前缀，不放行（工人没有工作目录就不接单）。
        // 前缀顺序不限：[org/repo] 在闸门标签/【agent】之后时从剥后标题再解析。
        const agentRepo =
          repoFromPlannedSummary(summary) ??
          repoFromPlannedSummary(summary.replace(/^【(待安排执行者|待确认仓库|agent)】\s*/, ""));
        if (!agentRepo) {
          reports.push(
            `🏷️ 「${summary.slice(0, 40)}」agent 任务未带 [org/repo] 前缀，无法定位仓库，留 P。请改标题为「[org/repo] 原标题」（如 [TiMEM-AI/TiMEM-Space] …），下轮自动放行。`,
          );
          continue;
        }
        const rec = reg.adopt({
          // 2026-10-26 拍板：新收集任务 → candidate（24h 审核窗口），
          // 群里「确认 R编号」→ candidate → planned（走闸门）→ ready
          title: summary,
          ...(t.description ? { description: t.description } : {}),
          status: "candidate",
          origin: { provider: FEISHU_TASK_PROVIDER, guid },
          projectRef: agentRepo,
        });
        // 收编可能是旧版（adopt 只补链不更新内容，2026-10-13 实测）：用列表全量描述强制刷新台账
        if (t.description && rec.description !== t.description) {
          reg.update(rec.uid, { description: t.description });
        }
        // 台账已在途（ready/dispatched/running/review）= 早已放行：静默跳过（防每拍 CAS 告警，2026-10-20）
        if (!["planned"].includes(rec.status ?? "")) {
          if ((rec.status ?? "") === "done" && !agentReleasedReported.has("done:" + guid)) {
            agentReleasedReported.add("done:" + guid);
            const checkGuid2 = sections.check;
            const movedDone = checkGuid2 ? await moveToSection(ctx, guid, opts.tasklistGuid, checkGuid2) : false;
            reports.push(
              movedDone
                ? `✅ 「${summary.slice(0, 40)}」台账已完成，已挪「${SECTION_NAMES.check}」待测试。`
                : `✅ 「${summary.slice(0, 40)}」台账已完成（挪 C 失败，请手动）。`,
            );
          }
          continue;
        }
        // A 案闸门（2026-10-24 用户拍板）：TASK_AUTO_DISPATCH=0 = 全手动。
        // 此前 agent 任务在「机器挪 D」闸门前就直通 ready（工人随即认领），
        // 用户看到「没挪卡就派发了」。开关关闭时，台账不动、卡留 P 等人挪。
        if (!autoDispatchEnabled()) {
          if (!agentReleasedReported.has("manual:" + guid)) {
            agentReleasedReported.add("manual:" + guid);
            reports.push(`⏸️ 「${summary.slice(0, 40)}」agent 任务要素齐备；TASK_AUTO_DISPATCH=0，留 P 待人工挪入「${SECTION_NAMES.doing}」授权执行。`);
          }
          continue;
        }
        const approved = reg.approve(rec.uid, {
          via: "auto",
          by: "system",
          note: "agent 任务五要素齐备，免工单直接放行（2026-10-13 拍板）",
        });
        // 失败重试门槛（2026-10-22）：failed 且 ≥2 次不再自动放行，升级人工
        if (approved.ok && (rec.attempts?.failed ?? 0) >= 2) {
          if (!agentReleasedReported.has("blocked:" + guid)) {
            agentReleasedReported.add("blocked:" + guid);
            const lastErr = String(rec.attempts?.lastError ?? rec.note ?? "").replace(/\s+/g, " ").slice(0, 180);
            reports.push([
              `🛑 「${(rec.title ?? summary).slice(0, 48)}」已失败 ${rec.attempts?.failed} 次，停止自动重试。`,
              `  归属：${String((rec as unknown as Record<string, unknown>).repo ?? rec.projectRef ?? "未定仓库")}｜台账：${rec.uid}`,
              `  最近失败：${lastErr || "（台账无败因记录）"}`,
              `  处理：排除后改标题重放行；确认放弃请标题加【挂起】。`,
            ].join("\n"));
          }
          continue;
        }
        if (approved.ok) {
          if (!agentReleasedReported.has(guid)) {
            agentReleasedReported.add(guid);
            reports.push(`🤖 agent 任务完备：「${cleanSummary(summary).slice(0, 60)}」→ 工人小组将认领执行。`);
          }
          continue;
        }
        reports.push(`⚠️ 「${summary.slice(0, 40)}」agent 任务台账放行失败：${approved.error}，留 P 下轮重试。`);
        continue;
      }
      // 人工/未标 agent 任务 → 原链路：挪 D（授权执行），由 dispatch-scan 派发。
      // TASK_AUTO_DISPATCH=0（2026-10-21 B 案）：只拦机器自动挪 D 这步（卡留 P），
      // 人工挪 D 不受控——挪进 D 即刻按统一标准派发（信息齐+无真人assignee+【agent】）。
      if (!autoDispatchEnabled()) {
        reports.push(`⏸️ 「${summary.slice(0, 40)}」核对通过；TASK_AUTO_DISPATCH=0 不自动挪 D，留在 P（手动挪 D 即授权派发）。`);
        continue;
      }
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
    // 执行开始通知（2026-10-21 用户拍板）：queued→running 迁移即推机器人群一次（每任务只报一次）
    if ((current.status ?? "") === "running" && !meta.startedAnnounced) {
      meta.startedAnnounced = true;
      const msg = `▶️ 「${(current.title ?? `工单 #${meta.issueNo}`).slice(0, 40)}」开始执行：agent 正在处理工单 #${meta.issueNo}（agentd 任务 \`${taskId}\`）。`;
      reports.push(msg);
      await dispatchNotify(opts.notifyChatId, msg);
    }
    if (["completed", "needs_review", "failed", "cancelled", "blocked"].includes(current.status ?? "")) {
      dispatchRuntime.inflight.delete(taskId);
      const msg = await writebackOnFinal(ctx, meta.repo, meta.issueNo, taskId, current.status ?? "", meta.tasklistGuid, sections, meta.feishuTaskGuid);
      reports.push(msg);
      await dispatchNotify(opts.notifyChatId, msg);
    }
  }

  // ② 扫 D 分组 → 派发（2026-10-21 拍板：不区分人工挪/自动双建，统一标准——
  // 信息齐全 + 无真人 assignee + 标记【agent】即派发；真人 assignee 留 D 自行处理）
  const doingTasks = await listSectionTasks(ctx, doingGuid);
  for (const t of doingTasks) {
    const summary = t.summary ?? "";
    const taskGuid = t.guid ?? t.task_id ?? "";
    const issueNo = issueNumberFromTaskSummary(summary);
    if (issueNo === undefined) {
      // D 组无工单号任务（2026-10-20 用户拍板）：不再静默跳过（防僵尸卡静默滞留）。
      // 闸门标签卡不处理；人工任务留 D；完备 agent 卡就地免工单放行；其余挪回 P 补全并群通知。
      if (summary.includes("【挂起】")) {
        // 2026-10-22 拍板：D 组挂起卡同样挪「挂起」分组 + 摘前缀（分组即状态）
        await pauseBySection(ctx, taskGuid, summary, opts.tasklistGuid, sections);
        continue;
      }
      if (
        summary.includes("【待补充】") ||
        summary.includes("【待安排执行者】") ||
        summary.includes("【待确认仓库】")
      ) {
        continue;
      }
      // 2026-10-20 拍板「有 assignee 的优先以 assignee 为准」：扫描接口的任务对象不带
      // members，先按台账行（assignee_member_id/描述标记）合并判定——体外负责人也算人。
      const ledgerRow = planGateRegistry
        ?.list()
        .find((r) => r.origin.provider === FEISHU_TASK_PROVIDER && r.origin.guid === taskGuid);
      const humanExecutor =
        executorOfTask(t) ??
        (ledgerRow?.assignee_member_id
          ? identityMembers(getIdentityRegistry()).find((m) => m.member_id === ledgerRow.assignee_member_id)
              ?.name ?? ledgerRow.assignee_member_id
          : undefined);
      if (humanExecutor) {
        reports.push(`👤 「${summary.slice(0, 40)}」执行人任务留 D 自行处理（负责人=执行人）。`);
        continue;
      }
      const bareSummary = summary.replace(/^【[^】]+】\s*/, "");
      // agent 判定只看标题【agent】前缀（2026-10-20 拍板：描述「执行者：」不再参与识别）
      const isAgent = /^【agent】/.test(summary) || /^【agent】/.test(bareSummary);
      const agentRepo = repoFromPlannedSummary(summary) ?? repoFromPlannedSummary(bareSummary);
      const planGuid = sections.plan;
      if (!isAgent || !agentRepo || !planGuid || !planGateRegistry || !taskGuid) {
        // 信息不全（无工单号；agent 卡缺仓库前缀/登记表未接）→ 挪回 P 补全 + 通知
        const back = planGuid && taskGuid ? await moveToSection(ctx, taskGuid, opts.tasklistGuid, planGuid) : false;
        const why = isAgent ? (agentRepo ? "登记表未接" : "缺 [org/repo] 前缀") : "缺工单号且未标 agent";
        const msg = back
          ? `⬅️ 「${summary.slice(0, 40)}」在 D 但信息不全（${why}），已挪回 P 补全，补全后自动调度。`
          : `⚠️ 「${summary.slice(0, 40)}」在 D 但信息不全（${why}），挪回 P 失败，请手动挪回。`;
        reports.push(msg);
        await dispatchNotify(opts.notifyChatId, msg);
        continue;
      }
      if (dispatchRuntime.inflight.size >= 3) {
        reports.push(`⏳ 并发上限（3），「${summary.slice(0, 40)}」留 D 下轮放行。`);
        continue;
      }
      const rec = planGateRegistry.adopt({
        title: bareSummary,
        ...(t.description ? { description: t.description } : {}),
        status: "candidate",
        origin: { provider: FEISHU_TASK_PROVIDER, guid: taskGuid },
        projectRef: agentRepo,
      });
      // adopt 只补链不更新内容（2026-10-13 实测）：用列表全量描述强制刷新台账
      if (t.description && rec.description !== t.description) {
        planGateRegistry.update(rec.uid, { description: t.description });
      }
      // 台账终态卡不该留在 D：done→C 待测试（与 PR 交付回写一致）；cancelled/failed→P 复核
      if ((rec.status ?? "") === "done") {
        const checkGuid = (sections as { check?: string }).check;
        await moveToSection(ctx, taskGuid, opts.tasklistGuid, checkGuid ?? planGuid);
        const msg = `✅ 「${summary.slice(0, 40)}」台账已完成，已挪「${SECTION_NAMES.check}」待测试。`;
        reports.push(msg);
        await dispatchNotify(opts.notifyChatId, msg);
        continue;
      }
      if ((rec.status ?? "") === "needs-input") {
        // 等决策可视化（2026-10-22）：板面无痕导致决策隐形滞留——卡打 ❓ 标 +
        // 机器人群点一次名（防重），决策落定后由 handleDecision 摘标。
        if (!agentReleasedReported.has("deciding:" + taskGuid)) {
          agentReleasedReported.add("deciding:" + taskGuid);
          if (!summary.startsWith("❓")) {
            await callFeishuApi(ctx, {
              method: "PATCH",
              path: `/open-apis/task/v2/tasks/${taskGuid}`,
              query: { user_id_type: "open_id" },
              identity: "user",
              body: { update_fields: ["summary"], task: { summary: `❓${summary}` } },
            }).catch(() => undefined);
          }
          const msg = `❓ 「${bareSummary.slice(0, 40)}」在等人工决策（机器人群有反问），卡已标注。回复「决策 <选项>」继续。`;
          reports.push(msg);
          await dispatchNotify(opts.notifyChatId, msg);
        }
        continue;
      }
      if (["cancelled", "failed"].includes(rec.status ?? "")) {
        await moveToSection(ctx, taskGuid, opts.tasklistGuid, planGuid);
        // 失败计数 +1（2026-10-22）：P 侧自动重放按它设门槛，防确定性失败无限循环
        planGateRegistry.bumpFailed(rec.uid, rec.note ?? rec.attempts?.lastError);
        const n = rec.attempts?.failed ?? 1;
        const lastErr = String(rec.attempts?.lastError ?? rec.note ?? "").replace(/\s+/g, " ").slice(0, 180);
        const msg =
          n >= 2
            ? [
                `🛑 「${(rec.title ?? summary).slice(0, 48)}」已失败 ${n} 次，停止自动重试。`,
                `  归属：${String((rec as unknown as Record<string, unknown>).repo ?? rec.projectRef ?? "未定仓库")}｜台账：${rec.uid}`,
                `  最近失败：${lastErr || "（台账无败因记录）"}`,
                `  处理：排除后改标题重放行；确认放弃请标题加【挂起】。`,
              ].join("\n")
            : `⬅️ 「${(rec.title ?? summary).slice(0, 40)}」台账已是「${rec.status}」，已挪回 P 自动重试 1 次（最近失败：${lastErr.slice(0, 100) || "无记录"}；如需重跑请改标题重放行）。`;
        reports.push(msg);
        await dispatchNotify(opts.notifyChatId, msg);
        continue;
      }
      const approved = planGateRegistry.approve(rec.uid, {
        via: "auto",
        by: "system",
        note: "agent 任务在 D 组信息完备，免工单放行（挪卡即授权）",
      });
      if (approved.ok) {
        if (summary.startsWith("❓")) {
          // 决策已落定重入队 → 摘 ❓ 标（决策即时回执在群里，板面同步在此收尾）
          await callFeishuApi(ctx, {
            method: "PATCH",
            path: `/open-apis/task/v2/tasks/${taskGuid}`,
            query: { user_id_type: "open_id" },
            identity: "user",
            body: { update_fields: ["summary"], task: { summary: summary.replace(/^❓\s*/, "") } },
          }).catch(() => undefined);
        }
        if (!agentReleasedReported.has(taskGuid)) {
          agentReleasedReported.add(taskGuid);
          reports.push(`🤖 agent 任务完备（D 组放行）：「${cleanSummary(summary).slice(0, 60)}」→ 工人小组将认领执行。`);
          await dispatchNotify(opts.notifyChatId, reports[reports.length - 1]);
        }
        continue;
      }
      // 放行失败但非终态 = 已放行在执行（CAS 拒重复 approve）：静默留 D 交工人小组
      if (summary.startsWith("❓")) {
        // 决策已落定/超时按默认续跑 → 摘 ❓ 标（best-effort；决策即时摘在 handleDecision）
        await callFeishuApi(ctx, {
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${taskGuid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { update_fields: ["summary"], task: { summary: summary.replace(/^❓\s*/, "") } },
        }).catch(() => undefined);
      }
      continue;
    }
    // 负责人=执行人（2026-10-10 铁律）：带执行人的 D 组任务是人工任务——
    // 留在 D、不派 agent（执行人自己干）。判定=executorOfTask（负责人>描述标记）
    const executor = executorOfTask(t);
    if (executor) {
      reports.push(`👤 「${summary.slice(0, 40)}」执行人「${executor}」，人工任务不派 agent，留在「${SECTION_NAMES.doing}」。`);
      continue;
    }
    const repoFromTitle = summary.match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
    // 无默认仓库机制（2026-10-13 拍板）：解析不出仓库不派发（工单归属未知，防派错仓库）
    if (!repoFromTitle) continue;
    const repo = `${repoFromTitle[1]}/${repoFromTitle[2]}`;
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
  // 执行者铁律（2026-10-10）：任务带执行人=人工任务，确认派发也拒绝（防误手把人工任务交给 agent）
  const fr = await callFeishuApi(ctx, {
    method: "GET",
    path: "/open-apis/task/v2/tasks",
    query: { page_size: 100, user_id_type: "open_id" },
    identity: "user",
  });
  const items = (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string; members?: TaskMemberLike[] }> })?.items ?? [];
  const ft = items.find((x) => issueNumberFromTaskSummary(x.summary ?? "") === issueNo);
  const executor = executorOfTask(ft);
  if (executor) {
    return `👤 工单 #${issueNo} 的任务执行人「${executor}」（负责人），是人工任务，不派 agent（确认被拒绝）。`;
  }
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
  // 「agent」是执行方式声明（不查人册）：写描述标记，不设负责人
  // 人员别名 → 登记表规范名（hongbin → shahongbin；中文名/花名/拼音同表）。
  // 登记表非空且解析不到 → 反问列出成员（不写任何数据）；歧义同样反问。
  const resolvedName = /^agent$/i.test(name) ? name : resolveExecutorName(name);
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
  const items = (fr.value?.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string; members?: TaskMemberLike[] }> })?.items ?? [];
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
  if (/^agent$/i.test(executorName)) {
    // agent 指派（2026-10-20 拍板收敛）：识别唯一源=标题【agent】前缀——直接打前缀，
    // 不再写描述「执行者：agent」标记（描述已退出 agent 识别）。
    const title0 = target.summary ?? "";
    if (/^【agent】/.test(title0.replace(/^【(待安排执行者|待确认仓库)】/, ""))) {
      return pendingNo !== undefined
        ? `⏭️ 澄清任务 #${pendingNo} 已是 agent 任务，无需重复安排。`
        : `⏭️ 工单 #${issueNo} 已是 agent 任务，无需重复安排。`;
    }
    const stripped = title0.replace(/^【(待安排执行者|待确认仓库)】/, "").trim();
    const newTitle = `【agent】${stripped}`;
    const ar = await callFeishuApi(ctx, {
      method: "PATCH",
      path: `/open-apis/task/v2/tasks/${guid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { update_fields: ["summary"], task: { summary: newTitle } },
    });
    if (!ar.ok || (ar.value?.code ?? -1) !== 0) {
      return `❌ 标记 agent 执行失败：${ar.ok ? ar.value?.msg : ar.error}`;
    }
    return pendingNo !== undefined
      ? `🤖 澄清任务 #${pendingNo} 已打【agent】前缀。请再回复「任务归属 ${pendingNo} org/仓库」确认归属（或标题加 [org/repo] 前缀）；齐备后自动由 agent 执行。`
      : `🤖 工单 #${issueNo} 已打【agent】前缀（不设负责人）。归属 [org/repo] 齐备后由 agent 自动执行。`;
  }
  if (assigneeFromTask(target) === executorName && (target.description ?? "").includes(marker)) {
    return `⏭️ ${pendingNo !== undefined ? `澄清任务 #${pendingNo}` : `工单 #${issueNo}`} 的执行人已是「${executorName}」（负责人已设置），无需重复安排。`;
  }

  // 执行人写入（2026-10-20 收敛）：人名 = 设飞书负责人（members assignee，主判据）+ 描述标记双保险；
  // agent 走上方标题前缀分支。

  // 执行人=飞书任务「负责人」（members assignee，2026-10-10 修正）：
  // ① open_id 速查登记表（别名→open_id），命中直接设负责人
  // ② 未命中 open_id → 用用户身份搜索换 open_id；仍失败则退回描述标记（不阻断）
  const reg = getIdentityRegistry();
  const member = resolveMemberByName(reg, executorName);
  let assigneeSet = false;
  let assigneeNote = "";
  const openId =
    member.kind === "exact"
      ? member.member.feishu_open_ids[0]
      : undefined;
  let resolvedOpenId = openId;
  if (!resolvedOpenId) {
    // 登记表没存 open_id：用用户身份搜索按名字找（search_user_id_type=open_id）
    const sr = await callFeishuApi(ctx, {
      method: "POST",
      path: "/open-apis/search/v1/user",
      query: { query: executorName, page_size: 5 },
      identity: "user",
    }).catch(() => undefined);
    const users = ((sr?.value?.data as { users?: Array<{ open_id?: string; name?: string }> })?.users ?? []);
    const hit = users.find((u) => (u.name ?? "").includes(executorName)) ?? users[0];
    if (hit?.open_id) resolvedOpenId = hit.open_id;
  }
  if (resolvedOpenId) {
    const am = await callFeishuApi(ctx, {
      method: "POST",
      path: `/open-apis/task/v2/tasks/${guid}/add_members`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { members: [{ id: resolvedOpenId, role: "assignee", type: "user" }] },
    });
    if (am.ok && (am.value?.code ?? -1) === 0) {
      assigneeSet = true;
    } else {
      assigneeNote = `负责人设置失败（${am.ok ? am.value?.msg || `code=${am.value?.code}` : am.error}），已退回描述标记；`;
    }
  } else {
    assigneeNote = "登记表/飞书搜不到该成员的飞书账号，";
  }

  // 双保险：描述仍记「执行者：」标记（旧判据兼容；负责人为主判据）
  if (!(target.description ?? "").includes(marker)) {
    const desc = (target.description ?? "").trimEnd();
    await callFeishuApi(ctx, {
      method: "PATCH",
      path: `/open-apis/task/v2/tasks/${guid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
      // 飞书 v2 更新接口要求 update_fields 声明 + task 包装（否则 99992402）
      body: { update_fields: ["description"], task: { description: desc ? `${desc}\n${marker}` : marker } },
    }).catch(() => undefined);
  }
  if (!assigneeSet && !resolvedOpenId) {
    return `⚠️ 已在任务描述记录执行者「${executorName}」，但${assigneeNote}未设为飞书负责人。请在飞书任务里手动添加负责人（后续以负责人判定人工任务）。`;
  }

  // 建单后路径：Gitea 工单评论留痕 + assignee 回写（失败不阻断：任务侧已记录）
  const repoMatch = (target.summary ?? "").match(/^\[([^\]#/]+)\/([^\]#]+)#\d+\]/);
  let giteaNote = "";
  if (repoMatch && issueNo !== undefined) {
    const repo = `${repoMatch[1]}/${repoMatch[2]}`;
    const cr = await callGiteaApi(ctx, {
      method: "POST",
      path: `${issuesBaseFor(repo)}/${issueNo}/comments`,
      body: { body: `执行者安排：**${executorName}**（由项目小助理记录）` },
    });
    if (!cr.ok || !is2xx(cr.value?.status ?? 0)) giteaNote = `（工单评论失败：${cr.ok ? `HTTP ${cr.value?.status}` : cr.error}）`;
    // 负责人回写工单 assignee（2026-10-10 用户确认）：登记表 名字/别名 → gitea_usernames[0]
    const regMember = identityMembers(reg).find((m) => m.name === executorName || m.aliases.includes(executorName));
    const giteaUser = regMember?.gitea_usernames[0];
    if (giteaUser) {
      const ar2 = await callGiteaApi(ctx, {
        method: "PATCH",
        path: `${issuesBaseFor(repo)}/${issueNo}`,
        body: { assignees: [giteaUser] },
      });
      if (ar2.ok && is2xx(ar2.value?.status ?? 0)) {
        giteaNote += `${giteaNote ? "；" : ""}工单 assignee 已设 ${giteaUser}`;
      } else {
        giteaNote += `${giteaNote ? "；" : ""}工单 assignee 设置失败（${ar2.ok ? `HTTP ${ar2.value?.status}` : ar2.error}）`;
      }
    }
  }

  return pendingNo !== undefined
    ? `👤 澄清任务 #${pendingNo} 已设执行人「${executorName}」${assigneeSet ? "（飞书负责人已设置）" : `（描述已标记；${assigneeNote}请在任务里补负责人）`}。请再回复「任务归属 ${pendingNo} 仓库/项目简称」确认归属；两者齐备后自动创建 Gitea 工单。`
    : `👤 工单 #${issueNo} 已设执行人「${executorName}」${assigneeSet ? "（飞书负责人已设置）" : `（描述已标记；${assigneeNote}请在任务里补负责人）`}${giteaNote}。任务将在下轮目标核对通过后进入「${SECTION_NAMES.doing}」执行队列。`;
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
    // 注：此处为聊天指令建单（用户主动要求，给真人接的单），不挂流水线标签/声明；
    // 防误接标记只用于 plan-gate 自动回填建单链（ensurePipelineLabelId 调用点）。
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
    if (adopted.length > 0) {
      // 点明任务名（2026-10-22 用户反馈：「检测到 1 条」看不出是哪条进了哪个清单）
      const names = adopted.map((n) => `「${n}」`).join("、");
      adoptedNote = `📥 收编 ${adopted.length} 条清单裸任务进「${SECTION_NAMES.plan}」：${names}`;
      await dispatchNotify(notifyChatId, `📥 检测到 ${adopted.length} 条直接建在本清单的新任务，已收编进「${SECTION_NAMES.plan}」：${names}。将依次完成工单回填与执行者安排。`);
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
    } else if (intent.kind === "align-now") {
      // 手动对齐（2026-10-10）：钩子由 loop 装配（对齐器一拍+状态队列一拍），编排层不持有调度器
      response = await runManualAlign();
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
    } else if (intent.kind === "decision") {
      // 决策回复（耳朵）：needs-input 反问的回收通道——写决策文件→重入队→worker-team 续跑
      response = await handleDecision(intent.ref, intent.option);
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
