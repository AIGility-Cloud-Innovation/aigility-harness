/**
 * @orchestration/project-briefing — 项目小助理多源汇总与记忆沉淀
 *
 * 职责（2026-09-30 与用户对齐的阶段性目标）：
 *   1. 人视角汇总（person-brief）：飞书任务 + Gitea 工单/PR + timem 记忆 →
 *      「我的任务安排情况」（聊天「我的任务」走这里）
 *   2. 项目视角汇总（project-brief）：某项目横跨 飞书群/任务清单/Gitea/运维日志 的进展
 *   3. 反馈写入（feedback）：用户给小助理的反馈沉淀进 timem（本人名下）
 *   4. 定期快照（write-digest）：每日定时 + 事件补充，把关键信息写入 timem
 *      （项目快照 → 虚拟用户 project:<id>；个人快照 → 本人 timem id）
 *
 * 身份/项目对齐数据来自两张登记表（mtime 缓存，平台改完即生效）：
 *   - config/timem-team-registry.json（人员三轴：feishu/gitea/timem）
 *   - config/project-registry.json（项目四源：群/清单约定/仓库/日志）
 *
 * 命名纪律（两维模型）：agent_id 恒为项目小助理（feishu-task-assistant）；
 * user_id 只标识「人」（规范键 = timem_user_ids[0]，未登记成员回退来源键
 * open_id，绝不用裸 anonymous）；项目级记忆放虚拟用户 project:<id> 名下。
 *
 * 所有数据源尽力而为：单个来源失败不阻塞其余，失败原因在响应尾部如实列出。
 */

import { LayerId, PluginState, ok } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import {
  getIdentityRegistry,
  findMemberByFeishuOpenId,
  resolveMemberByName,
  canonicalTimemUserId,
  identityMembers,
  type IdentityMember,
} from "./identity-registry.js";
import {
  getProjectRegistry,
  findProjectByRepo,
  projectRepoScope,
  projectMemoryUserKey,
  resolveProjectRef,
  type ProjectEntry,
  type ProjectLogSource,
} from "./project-registry.js";
import { SECTION_NAMES } from "./task-issue-sync.js";

// ── 常量 ─────────────────────────────────────────────────────────

/** 项目小助理记忆命名空间（agent_id 维度，稳定不变） */
export function briefingAgentId(): string {
  return process.env.BRIEFING_AGENT_ID ?? "feishu-task-assistant";
}

function logTimeoutMs(): number {
  return Number(process.env.BRIEFING_LOG_TIMEOUT_MS ?? "5000");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(d: Date): string {
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── 请求/响应 ────────────────────────────────────────────────────

export type ProjectBriefingRequest =
  | {
      /** 人视角汇总：「我的任务」——跨来源聚合本人的任务安排情况 */
      mode: "person-brief";
      /** 用户标识（飞书 open_id，或花名册 member_id/姓名） */
      user_id?: string;
      /** 是否附带 timem 记忆召回（默认 true） */
      include_memory?: boolean;
    }
  | {
      /** 项目视角汇总：某项目横跨飞书/任务清单/Gitea/日志的进展 */
      mode: "project-brief";
      /** 项目 id/名称/别名；缺省 = 汇总全部项目 */
      project?: string;
    }
  | {
      /** 反馈写入：把用户的反馈沉淀进 timem（本人名下，可关联项目） */
      mode: "feedback";
      user_id?: string;
      text: string;
      /** 可选关联项目（id/名称/别名） */
      project?: string;
    }
  | {
      /** 快照写入：每日定时 / 事件补充（装配层调度器与 briefing-events 调用） */
      mode: "write-digest";
      trigger?: "daily" | "event";
      /** 项目 id（或 org:<组织>）；缺省 = 全部项目 */
      project?: string;
      /** 事件触发的说明（如「新建工单 #12」），并入快照内容 */
      note?: string;
    };

export interface ProjectBriefingResponse {
  /** 用户回复文本（digest 模式 = 写入结果摘要） */
  response: string;
  /** 成功取到数据的来源 */
  sources_ok: string[];
  /** 失败/跳过的来源及原因（如实透出，不静默） */
  sources_failed: string[];
}

export const projectBriefingService: ServiceDefinition<ProjectBriefingRequest, ProjectBriefingResponse> = {
  id: "@orchestration/project-briefing",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "项目小助理多源汇总：人/项目视角聚合 飞书任务+Gitea 工单/PR+timem 记忆+运维日志；反馈与定期快照写入 timem",
};

// ── 数据形态 ─────────────────────────────────────────────────────

export interface IssueLite {
  repo: string;
  number: number;
  title: string;
  state: string;
  assignees: string[];
  createdBy?: string;
  htmlUrl?: string;
}

export interface PullLite {
  repo: string;
  number: number;
  title: string;
  user: string;
  state: string;
  htmlUrl?: string;
}

export interface TaskLite {
  guid?: string;
  summary?: string;
  description?: string;
  /** 所属分组名（P 计划中 / D 执行中 / …） */
  section?: string;
  /** 任务清单 = Gitea 组织名 */
  org?: string;
}

export interface LogErr {
  t: number;
  src: string;
  line: string;
}

export interface LogSnapshot {
  p: string;
  s: string;
  lastErr?: string;
  errs: LogErr[];
  error?: string;
}

export interface RepoSnapshot {
  repo: string;
  issues: IssueLite[];
  pulls: PullLite[];
  error?: string;
}

// ── Seam 调用封装（尽力而为） ────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

async function giteaGet(
  ctx: SeamContext,
  path: string,
  query?: Record<string, string | number | boolean>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const r = (await ctx.call(
      { id: "@action/gitea-api", versionRange: "^1.0.0" },
      { path, query },
    )) as { ok?: boolean; value?: { status?: number; data?: unknown }; error?: string };
    if (!r?.ok) return { ok: false, error: r?.error ?? "gitea-api 无响应" };
    const status = r.value?.status ?? 0;
    if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` };
    return { ok: true, data: r.value?.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function feishuApi(
  ctx: SeamContext,
  req: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const r = (await ctx.call(
      { id: "@action/feishu-api", versionRange: "^1.0.0" },
      req,
    )) as { ok?: boolean; value?: { code?: number; msg?: string; data?: unknown }; error?: string };
    if (!r?.ok) return { ok: false, error: r?.error ?? "feishu-api 无响应" };
    const code = r.value?.code ?? -1;
    if (code !== 0) return { ok: false, error: r.value?.msg ?? `飞书 code=${code}` };
    return { ok: true, data: r.value?.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function timemSearch(
  ctx: SeamContext,
  params: { query: string; userId: string; domain?: string; limit?: number },
): Promise<{ ok: boolean; items: string[]; error?: string }> {
  try {
    const r = (await ctx.call(
      { id: "@action/timem-memory", versionRange: "^1.0.0" },
      {
        query: params.query,
        user_id: params.userId,
        agent_id: briefingAgentId(),
        ...(params.domain ? { domain: params.domain } : {}),
        limit: params.limit ?? 5,
      },
    )) as { ok?: boolean; value?: { ok?: boolean; results?: Array<{ content?: string }>; error?: string }; error?: string };
    if (!r?.ok) return { ok: false, items: [], error: r?.error ?? "timem 检索无响应" };
    if (r.value?.ok === false) return { ok: false, items: [], error: r.value?.error ?? "timem 检索失败" };
    const items = (r.value?.results ?? []).map((x) => (x?.content ?? "").trim()).filter(Boolean);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: String(e) };
  }
}

async function timemWrite(
  ctx: SeamContext,
  params: { content: string; userId: string; domain?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = (await ctx.call(
      { id: "@action/timem-memory-write", versionRange: "^1.0.0" },
      {
        content: params.content,
        user_id: params.userId,
        agent_id: briefingAgentId(),
        ...(params.domain ? { domain: params.domain } : {}),
      },
    )) as { ok?: boolean; value?: { ok?: boolean; error?: string }; error?: string };
    if (!r?.ok) return { ok: false, error: r?.error ?? "timem 写入无响应" };
    if (r.value?.ok === false) return { ok: false, error: r.value?.error ?? "timem 写入失败" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── 采集器 ───────────────────────────────────────────────────────

/** org 维度仓库展开（/orgs/{org}/repos；失败记入 errors 不阻塞） */
export async function expandOrgRepos(
  ctx: SeamContext,
  orgs: string[],
  errors: string[],
): Promise<string[]> {
  const repos = new Set<string>();
  for (const org of orgs) {
    const r = await giteaGet(ctx, `/api/v1/orgs/${org}/repos`, { limit: 50 });
    if (!r.ok || !Array.isArray(r.data)) {
      errors.push(`gitea(org:${org}) ${r.error ?? "响应格式异常"}`);
      continue;
    }
    for (const it of r.data as Array<{ full_name?: string; owner?: { login?: string }; name?: string }>) {
      const full = it.full_name ?? (it.owner?.login && it.name ? `${it.owner.login}/${it.name}` : "");
      if (full) repos.add(full);
    }
  }
  return [...repos];
}

/** 拉一组仓库的 open 工单 + open PR（逐仓尽力而为，单仓失败记 error） */
export async function collectRepos(ctx: SeamContext, repos: string[]): Promise<RepoSnapshot[]> {
  const out: RepoSnapshot[] = [];
  for (const repo of repos) {
    const issues: IssueLite[] = [];
    const pulls: PullLite[] = [];
    let error: string | undefined;
    const ir = await giteaGet(ctx, `/api/v1/repos/${repo}/issues`, { state: "open", type: "issues", limit: 50 });
    if (ir.ok && Array.isArray(ir.data)) {
      for (const it of ir.data as Array<Record<string, any>>) {
        issues.push({
          repo,
          number: Number(it.number ?? 0),
          title: String(it.title ?? ""),
          state: String(it.state ?? "open"),
          assignees: (it.assignees ?? []).map((a: any) => String(a?.login ?? "")).filter(Boolean),
          createdBy: it.user?.login ? String(it.user.login) : undefined,
          htmlUrl: it.html_url ? String(it.html_url) : undefined,
        });
      }
    } else {
      error = `issues: ${ir.error ?? "响应格式异常"}`;
    }
    const pr = await giteaGet(ctx, `/api/v1/repos/${repo}/pulls`, { state: "open", limit: 50 });
    if (pr.ok && Array.isArray(pr.data)) {
      for (const it of pr.data as Array<Record<string, any>>) {
        pulls.push({
          repo,
          number: Number(it.number ?? 0),
          title: String(it.title ?? ""),
          user: String(it.user?.login ?? ""),
          state: String(it.state ?? "open"),
          htmlUrl: it.html_url ? String(it.html_url) : undefined,
        });
      }
    } else if (!error) {
      error = `pulls: ${pr.error ?? "响应格式异常"}`;
    }
    out.push({ repo, issues, pulls, error });
  }
  return out;
}

/**
 * 拉各组织任务清单里 P/D 等分组的未完成任务（清单名 = 组织名，既有约定）。
 * 用户身份 token 由 @action/feishu-api 管理；清单/分组不存在时静默返回空。
 */
export async function collectOrgTasks(ctx: SeamContext, orgs: string[]): Promise<{ tasks: TaskLite[]; errors: string[] }> {
  const tasks: TaskLite[] = [];
  const errors: string[] = [];
  for (const org of orgs) {
    const lr = await feishuApi(ctx, {
      method: "GET",
      path: "/open-apis/task/v2/tasklists",
      query: { page_size: 50, user_id_type: "open_id" },
      identity: "user",
    });
    if (!lr.ok) {
      errors.push(`feishu(tasklists) ${lr.error}`);
      continue;
    }
    const list = ((lr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []).find(
      (t) => (t.name ?? "").toLowerCase() === org.toLowerCase(),
    );
    if (!list?.guid) continue; // 该组织还没建清单
    const sr = await feishuApi(ctx, {
      method: "GET",
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: list.guid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    });
    if (!sr.ok) {
      errors.push(`feishu(sections:${org}) ${sr.error}`);
      continue;
    }
    const sections = (sr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? [];
    for (const sec of sections) {
      if (!sec.guid) continue;
      const tr = await feishuApi(ctx, {
        method: "GET",
        path: `/open-apis/task/v2/sections/${sec.guid}/tasks`,
        query: { completed: false, page_size: 50, user_id_type: "open_id" },
        identity: "user",
      });
      if (!tr.ok) {
        errors.push(`feishu(tasks:${org}/${sec.name}) ${tr.error}`);
        continue;
      }
      for (const t of (tr.data as { items?: Array<{ guid?: string; task_id?: string; summary?: string; description?: string }> })?.items ?? []) {
        tasks.push({ guid: t.guid ?? t.task_id, summary: t.summary, description: t.description, section: sec.name, org });
      }
    }
  }
  return { tasks, errors };
}

export interface BriefingDeps {
  /** log-monitor /status 拉取（可注入替换；默认 fetch） */
  fetchLogStatus?: (url: string) => Promise<unknown>;
  now?: () => Date;
}

function parseLogStatus(raw: unknown, p: string, s: string): { lastErr?: string; errs: LogErr[] } {
  const data = raw as {
    autos?: Array<{ p?: string; s?: string; lastErr?: string }>;
    errs?: Array<{ t?: number; src?: string; line?: string }>;
  };
  const auto = (data?.autos ?? []).find((a) => a.p === p && a.s === s);
  const prefix = `${p} / ${s}`;
  const errs = (data?.errs ?? [])
    .filter((e) => e.src === prefix)
    .map((e) => ({ t: Number(e.t ?? 0), src: String(e.src ?? ""), line: String(e.line ?? "") }));
  return { lastErr: auto?.lastErr || undefined, errs };
}

/** 拉项目登记的运维日志监控项（/status 一次拿全量再按 p/s 过滤） */
export async function collectLogs(
  sources: ProjectLogSource[],
  deps?: BriefingDeps,
): Promise<{ logs: LogSnapshot[]; errors: string[] }> {
  const logs: LogSnapshot[] = [];
  const errors: string[] = [];
  const byHost = new Map<string, unknown>();
  for (const src of sources) {
    try {
      let raw = byHost.get(src.host);
      if (raw === undefined) {
        const fetcher = deps?.fetchLogStatus ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(logTimeoutMs()) }).then((r) => r.json()));
        raw = await fetcher(`${src.host.replace(/\/$/, "")}/status?errs=10`);
        byHost.set(src.host, raw);
      }
      const parsed = parseLogStatus(raw, src.p, src.s);
      logs.push({ p: src.p, s: src.s, ...parsed });
    } catch (e) {
      errors.push(`log-monitor(${src.p}/${src.s}) ${String(e)}`);
    }
  }
  return { logs, errors };
}

// ── 纯函数：按人切片（导出供单测） ───────────────────────────────

function lc(s: string): string {
  return s.trim().toLowerCase();
}

/** 工单按人切片：执行人是本人 / 本人提出 */
export function issuesForUser(
  snaps: RepoSnapshot[],
  usernames: string[],
): { assigned: IssueLite[]; created: IssueLite[] } {
  const us = usernames.map(lc).filter(Boolean);
  const assigned: IssueLite[] = [];
  const created: IssueLite[] = [];
  for (const snap of snaps) {
    for (const i of snap.issues) {
      if (i.assignees.some((a) => us.includes(lc(a)))) assigned.push(i);
      else if (i.createdBy && us.includes(lc(i.createdBy))) created.push(i);
    }
  }
  return { assigned, created };
}

/** PR 按人切片：本人提交的 open PR */
export function pullsForUser(snaps: RepoSnapshot[], usernames: string[]): PullLite[] {
  const us = usernames.map(lc).filter(Boolean);
  const out: PullLite[] = [];
  for (const snap of snaps) for (const p of snap.pulls) if (us.includes(lc(p.user))) out.push(p);
  return out;
}

/**
 * 飞书任务按人切片：任务描述含「执行者：<姓名/别名>」（既有约定，
 * handleAssignExecutor 写入）或标题含姓名。飞书任务 v2 列表接口不回执行人
 * open_id，按描述标记匹配是当前数据形态下的可靠途径。
 */
export function tasksForUser(tasks: TaskLite[], names: string[]): TaskLite[] {
  const ns = names.map((n) => n.trim()).filter(Boolean);
  if (ns.length === 0) return [];
  const out: TaskLite[] = [];
  for (const t of tasks) {
    const desc = t.description ?? "";
    const summary = t.summary ?? "";
    const hit = ns.some(
      (n) => desc.includes(`执行者：${n}`) || desc.includes(`执行者:${n}`) || summary.includes(n),
    );
    if (hit) out.push(t);
  }
  return out;
}

// ── 纯函数：渲染（导出供单测） ───────────────────────────────────

function issueLine(i: IssueLite): string {
  return `${i.repo}#${i.number} ${i.title}${i.assignees.length ? `（执行: ${i.assignees.join("/")}）` : ""}`;
}

function renderSourceNote(sourcesOk: string[], sourcesFailed: string[]): string {
  const parts: string[] = [];
  if (sourcesFailed.length > 0) parts.push(`⚠️ 来源异常: ${sourcesFailed.join("；")}`);
  else parts.push(`✅ 来源正常: ${sourcesOk.join("、")}`);
  return parts.join("\n");
}

export interface PersonBriefInput {
  now: Date;
  member?: IdentityMember;
  /** 未登记时的原始来源键（open_id） */
  fallbackUserId?: string;
  assigned: IssueLite[];
  created: IssueLite[];
  pulls: PullLite[];
  tasks: TaskLite[];
  memories: string[];
  sourcesOk: string[];
  sourcesFailed: string[];
}

export function renderPersonBrief(input: PersonBriefInput): string {
  const label = input.member ? `${input.member.name}` : `${input.fallbackUserId ?? "未知用户"}（未登记）`;
  const lines: string[] = [`📋 ${label} 的任务安排（${fmtTime(input.now)}）`];

  if (!input.member) {
    lines.push(
      "ℹ️ 你的身份还未登记进团队花名册，暂时只能看到你的记忆，无法聚合 Gitea/飞书数据。",
      "　 请管理员在智悦平台「身份对齐」页把你的飞书账号绑定到花名册。",
    );
  }
  if (input.assigned.length > 0) {
    lines.push("", `🎫 待办工单（执行人是我，${input.assigned.length}）`);
    for (const i of input.assigned.slice(0, 10)) lines.push(`• ${issueLine(i)}`);
  }
  if (input.created.length > 0) {
    lines.push("", `📝 我提出的进行中工单（${input.created.length}）`);
    for (const i of input.created.slice(0, 5)) lines.push(`• ${issueLine(i)}`);
  }
  if (input.pulls.length > 0) {
    lines.push("", `🔀 我的 open PR（${input.pulls.length}）`);
    for (const p of input.pulls.slice(0, 8)) lines.push(`• ${p.repo}#${p.number} ${p.title}`);
  }
  if (input.tasks.length > 0) {
    lines.push("", `☑️ 飞书任务（${input.tasks.length}）`);
    for (const t of input.tasks.slice(0, 10)) {
      lines.push(`• ${t.section ? `[${t.section}] ` : ""}${(t.summary ?? "(无标题)").slice(0, 60)}`);
    }
  }
  if (input.assigned.length + input.created.length + input.pulls.length + input.tasks.length === 0) {
    lines.push("", "当前没有进行中的工单 / PR / 飞书任务。");
  }
  if (input.memories.length > 0) {
    lines.push("", "🧠 相关记忆");
    for (const m of input.memories.slice(0, 5)) lines.push(`• ${m.slice(0, 120)}`);
  }
  lines.push("", renderSourceNote(input.sourcesOk, input.sourcesFailed));
  return lines.join("\n");
}

export interface ProjectBriefInput {
  now: Date;
  project: ProjectEntry;
  snaps: RepoSnapshot[];
  tasks: TaskLite[];
  logs: LogSnapshot[];
  memories: string[];
  sourcesOk: string[];
  sourcesFailed: string[];
}

export function renderProjectBrief(input: ProjectBriefInput): string {
  const p = input.project;
  const openIssues = input.snaps.flatMap((s) => s.issues);
  const openPulls = input.snaps.flatMap((s) => s.pulls);
  const lines: string[] = [
    `📊 ${p.name}（${p.project_id}）进展（${fmtTime(input.now)}）`,
    `仓库 ${input.snaps.length} 个｜open 工单 ${openIssues.length}｜open PR ${openPulls.length}｜飞书未完任务 ${input.tasks.length}`,
  ];
  if (openIssues.length > 0) {
    lines.push("", "🎫 进行中工单（按仓库，最多 10 条）");
    for (const i of openIssues.slice(0, 10)) lines.push(`• ${issueLine(i)}`);
  }
  if (openPulls.length > 0) {
    lines.push("", "🔀 open PR（最多 8 条）");
    for (const pr of openPulls.slice(0, 8)) lines.push(`• ${pr.repo}#${pr.number} ${pr.title}（${pr.user || "?"}）`);
  }
  const doing = input.tasks.filter((t) => (t.section ?? "").startsWith("D"));
  if (doing.length > 0) {
    lines.push("", `☑️ 执行中任务（${doing.length}，最多 8 条）`);
    for (const t of doing.slice(0, 8)) lines.push(`• ${(t.summary ?? "(无标题)").slice(0, 60)}`);
  }
  const logErrs = input.logs.filter((l) => l.errs.length > 0 || l.lastErr);
  if (logErrs.length > 0) {
    lines.push("", "🚨 运维日志异常");
    for (const l of logErrs.slice(0, 4)) {
      lines.push(`• ${l.p}/${l.s}${l.lastErr ? ` lastErr=${l.lastErr.slice(0, 80)}` : ""}`);
      for (const e of l.errs.slice(0, 2)) lines.push(`  └ ${e.line.slice(0, 100)}`);
    }
  }
  if (input.memories.length > 0) {
    lines.push("", "🧠 项目记忆");
    for (const m of input.memories.slice(0, 4)) lines.push(`• ${m.slice(0, 120)}`);
  }
  lines.push("", renderSourceNote(input.sourcesOk, input.sourcesFailed));
  return lines.join("\n");
}

/** 项目快照（写入 timem project:<id> 名下） */
export function buildProjectDigestText(input: {
  now: Date;
  project: ProjectEntry;
  snaps: RepoSnapshot[];
  tasks: TaskLite[];
  logs: LogSnapshot[];
  trigger: "daily" | "event";
  note?: string;
}): string {
  const openIssues = input.snaps.flatMap((s) => s.issues);
  const openPulls = input.snaps.flatMap((s) => s.pulls);
  const doing = input.tasks.filter((t) => (t.section ?? "").startsWith("D"));
  const planned = input.tasks.filter((t) => (t.section ?? "").startsWith("P"));
  const logErrs = input.logs.filter((l) => l.errs.length > 0 || l.lastErr);
  const head = `【项目快照·${input.trigger === "daily" ? "每日" : "事件"}】${input.project.name}（${input.project.project_id}）@ ${fmtDate(input.now)}${input.note ? `｜触发: ${input.note}` : ""}`;
  const body: string[] = [
    `工单: open ${openIssues.length}${openIssues.length ? `（如 ${openIssues.slice(0, 3).map((i) => `#${i.number} ${i.title.slice(0, 24)}`).join("、")}）` : ""}`,
    `PR: open ${openPulls.length}${openPulls.length ? `（如 ${openPulls.slice(0, 3).map((x) => `#${x.number} ${x.title.slice(0, 24)}`).join("、")}）` : ""}`,
    `飞书任务: ${SECTION_NAMES.doing} ${doing.length} / ${SECTION_NAMES.plan} ${planned.length}`,
  ];
  if (logErrs.length > 0) {
    body.push(`日志异常: ${logErrs.map((l) => `${l.p}/${l.s}${l.lastErr ? `(${l.lastErr.slice(0, 40)})` : ""}`).join("；")}`);
  }
  return `${head}\n${body.join("\n")}`;
}

/** 个人快照（写入 timem 本人名下） */
export function buildMemberDigestText(input: {
  now: Date;
  member: IdentityMember;
  assigned: IssueLite[];
  created: IssueLite[];
  pulls: PullLite[];
  tasks: TaskLite[];
  trigger: "daily" | "event";
}): string {
  const head = `【个人快照·${input.trigger === "daily" ? "每日" : "事件"}】${input.member.name} @ ${fmtDate(input.now)}`;
  const parts: string[] = [];
  if (input.assigned.length > 0) {
    parts.push(`待办工单 ${input.assigned.length}（如 ${input.assigned.slice(0, 3).map(issueLine).join("；").slice(0, 120)}）`);
  }
  if (input.created.length > 0) parts.push(`我提出的进行中工单 ${input.created.length}`);
  if (input.pulls.length > 0) parts.push(`open PR ${input.pulls.length}（${input.pulls.map((x) => `${x.repo.split("/")[1] ?? x.repo}#${x.number}`).join("、")}）`);
  if (input.tasks.length > 0) {
    parts.push(`飞书任务 ${input.tasks.length}（${input.tasks.slice(0, 3).map((t) => (t.summary ?? "").slice(0, 20)).join("、")}）`);
  }
  if (parts.length === 0) return `${head}\n当前无进行中的工单/PR/任务。`;
  return `${head}\n${parts.join("；")}`;
}

// ── Provider ─────────────────────────────────────────────────────

/** 全部项目的仓库/组织范围（登记表驱动） */
function allScope(file: ReturnType<typeof getProjectRegistry>): { repos: string[]; orgs: string[] } {
  const repos = new Set<string>();
  const orgs = new Set<string>();
  for (const p of file.projects) {
    const s = projectRepoScope(p);
    for (const r of s.repos) repos.add(r);
    for (const o of s.orgs) orgs.add(o);
  }
  return { repos: [...repos], orgs: [...orgs] };
}

/** 项目登记键（含 org:<组织> 回退形态）→ 项目条目 */
function resolveProjectKey(key: string): ProjectEntry | undefined {
  const file = getProjectRegistry();
  if (key.startsWith("org:")) {
    const org = key.slice(4);
    return file.projects.find((p) => (p.gitea_orgs ?? []).includes(org));
  }
  const byRepo = findProjectByRepo(file, key);
  if (byRepo) return byRepo;
  return resolveProjectRef(file, key).project;
}

export function createProjectBriefingProvider(deps?: BriefingDeps): Provider<ProjectBriefingRequest, ProjectBriefingResponse> {
  return {
    service: projectBriefingService,
    name: "orchestration-project-briefing",
    state: PluginState.Active,

    async execute(request, ctx): Promise<Result<ProjectBriefingResponse>> {
      const sourcesOk: string[] = [];
      const sourcesFailed: string[] = [];
      const now = deps?.now?.() ?? new Date();

      try {
        switch (request.mode) {
          case "person-brief":
            return ok(await runPersonBrief(request, ctx, { sourcesOk, sourcesFailed, now }));
          case "project-brief":
            return ok(await runProjectBrief(request, ctx, { sourcesOk, sourcesFailed, now }, deps));
          case "feedback":
            return ok(await runFeedback(request, ctx, { sourcesOk, sourcesFailed, now }));
          case "write-digest":
            return ok(await runWriteDigest(request, ctx, { sourcesOk, sourcesFailed, now }, deps));
        }
      } catch (e) {
        return ok({
          response: `❌ 汇总失败: ${e instanceof Error ? e.message : String(e)}`,
          sources_ok: sourcesOk,
          sources_failed: [...sourcesFailed, String(e)],
        });
      }
    },

    async health(): Promise<HealthStatus> {
      const projects = getProjectRegistry().projects.length;
      const members = identityMembers(getIdentityRegistry()).length;
      return {
        healthy: true,
        detail: `project-briefing ready（项目 ${projects} 个，花名册 ${members} 人）`,
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

interface RunCtx {
  sourcesOk: string[];
  sourcesFailed: string[];
  now: Date;
}

/** 花名册解析：open_id 优先，其次当 member_id/姓名解析 */
function resolveMember(userId?: string): IdentityMember | undefined {
  if (!userId) return undefined;
  const file = getIdentityRegistry();
  const byOpenId = findMemberByFeishuOpenId(file, userId);
  if (byOpenId) return byOpenId;
  const byName = resolveMemberByName(file, userId);
  return byName.kind === "exact" ? byName.member : undefined;
}

async function runPersonBrief(
  request: Extract<ProjectBriefingRequest, { mode: "person-brief" }>,
  ctx: SeamContext,
  rc: RunCtx,
): Promise<ProjectBriefingResponse> {
  const member = resolveMember(request.user_id);
  const file = getProjectRegistry();
  const scope = allScope(file);
  const errors: string[] = [];

  const repos = await expandOrgRepos(ctx, scope.orgs, errors);
  const snaps = await collectRepos(ctx, [...scope.repos, ...repos]);
  for (const s of snaps) {
    if (s.error) errors.push(`${s.repo} ${s.error}`);
  }

  const { tasks, errors: taskErrors } = await collectOrgTasks(ctx, scope.orgs);
  errors.push(...taskErrors);

  const names = member ? [member.name, ...member.aliases] : [];
  const usernames = member ? member.gitea_usernames : [];
  const slice = issuesForUser(snaps, usernames);
  const pulls = pullsForUser(snaps, usernames);
  const myTasks = member ? tasksForUser(tasks, names) : [];

  let memories: string[] = [];
  if (request.include_memory !== false) {
    // 命名纪律：登记成员用规范 timem id；未登记用来源键（open_id），绝不用 anonymous
    const memoryUserId = member ? canonicalTimemUserId(member) : request.user_id;
    if (memoryUserId) {
      const mem = await timemSearch(ctx, { query: "我的任务 安排 进展 反馈", userId: memoryUserId, limit: 5 });
      if (mem.ok) {
        memories = mem.items;
        rc.sourcesOk.push("timem");
      } else {
        rc.sourcesFailed.push(`timem: ${mem.error}`);
      }
    }
  }
  if (snaps.some((s) => !s.error)) rc.sourcesOk.push("gitea");
  if (tasks.length > 0 || taskErrors.length === 0) rc.sourcesOk.push("feishu");

  const response = renderPersonBrief({
    now: rc.now,
    member,
    fallbackUserId: request.user_id,
    assigned: slice.assigned,
    created: slice.created,
    pulls,
    tasks: myTasks,
    memories,
    sourcesOk: [...new Set([...rc.sourcesOk])],
    sourcesFailed: [...new Set([...errors, ...rc.sourcesFailed])],
  });
  return { response, sources_ok: rc.sourcesOk, sources_failed: [...new Set([...errors, ...rc.sourcesFailed])] };
}

async function runProjectBrief(
  request: Extract<ProjectBriefingRequest, { mode: "project-brief" }>,
  ctx: SeamContext,
  rc: RunCtx,
  deps?: BriefingDeps,
): Promise<ProjectBriefingResponse> {
  const file = getProjectRegistry();
  let projects: ProjectEntry[];
  if (request.project?.trim()) {
    const resolved = resolveProjectRef(file, request.project);
    if (resolved.project) projects = [resolved.project];
    else if (resolved.ambiguous) {
      return {
        response: `「${request.project}」匹配到多个项目：${resolved.ambiguous.map((p) => p.name).join("、")}。请说具体一点。`,
        sources_ok: [],
        sources_failed: [],
      };
    } else {
      return {
        response: `没有找到项目「${request.project}」。已登记: ${file.projects.map((p) => `${p.name}(${p.project_id})`).join("、") || "（项目登记表为空）"}`,
        sources_ok: [],
        sources_failed: [],
      };
    }
  } else {
    projects = file.projects;
  }
  if (projects.length === 0) {
    return { response: "项目登记表为空，请先在 config/project-registry.json 登记项目。", sources_ok: [], sources_failed: [] };
  }

  // 多项目合并为一份总览（数据一次采集，按项目切片渲染）
  const scopeRepos = new Set<string>();
  const orgs = new Set<string>();
  for (const p of projects) {
    const s = projectRepoScope(p);
    for (const r of s.repos) scopeRepos.add(r);
    for (const o of s.orgs) orgs.add(o);
  }
  const errors: string[] = [];
  const expanded = await expandOrgRepos(ctx, [...orgs], errors);
  for (const r of expanded) scopeRepos.add(r);
  const snaps = await collectRepos(ctx, [...scopeRepos]);
  for (const s of snaps) if (s.error) errors.push(`${s.repo} ${s.error}`);
  const { tasks, errors: taskErrors } = await collectOrgTasks(ctx, [...orgs]);
  errors.push(...taskErrors);
  const { logs, errors: logErrors } = await collectLogs(
    projects.flatMap((p) => p.log_sources ?? []),
    deps,
  );
  errors.push(...logErrors);

  let memories: string[] = [];
  if (projects.length === 1) {
    const p = projects[0];
    const mem = await timemSearch(ctx, { query: "项目 进展 风险 快照", userId: projectMemoryUserKey(p.project_id), domain: p.project_id, limit: 4 });
    if (mem.ok) {
      memories = mem.items;
      rc.sourcesOk.push("timem");
    } else {
      errors.push(`timem: ${mem.error}`);
    }
  }
  if (snaps.some((s) => !s.error)) rc.sourcesOk.push("gitea");
  if (logs.length > 0) rc.sourcesOk.push("log-monitor");
  rc.sourcesOk.push("feishu");

  const response =
    projects.length === 1
      ? renderProjectBrief({
          now: rc.now,
          project: projects[0],
          snaps: snaps.filter((s) => projectRepoScope(projects[0]).repos.includes(s.repo) || expanded.includes(s.repo)),
          tasks: tasks.filter((t) => orgs.has(t.org ?? "")),
          logs,
          memories,
          sourcesOk: rc.sourcesOk,
          sourcesFailed: [...new Set(errors)],
        })
      : [
          `📊 全部项目进展（${fmtTime(rc.now)}）`,
          ...projects.map((p) => {
            const pRepos = new Set([...projectRepoScope(p).repos]);
            for (const o of projectRepoScope(p).orgs) for (const r of expanded) if (r.startsWith(`${o}/`)) pRepos.add(r);
            const pSnaps = snaps.filter((s) => pRepos.has(s.repo));
            const pOrgs = new Set(projectRepoScope(p).orgs);
            return renderProjectBrief({
              now: rc.now,
              project: p,
              snaps: pSnaps,
              tasks: tasks.filter((t) => pOrgs.has(t.org ?? "")),
              logs: logs.filter((l) => (p.log_sources ?? []).some((x) => x.p === l.p && x.s === l.s)),
              memories: [],
              sourcesOk: rc.sourcesOk,
              sourcesFailed: [...new Set(errors)],
            });
          }).join("\n\n———\n\n"),
        ].join("\n");

  return { response, sources_ok: rc.sourcesOk, sources_failed: [...new Set(errors)] };
}

async function runFeedback(
  request: Extract<ProjectBriefingRequest, { mode: "feedback" }>,
  ctx: SeamContext,
  rc: RunCtx,
): Promise<ProjectBriefingResponse> {
  const text = (request.text ?? "").trim();
  if (!text) {
    return { response: "用法：反馈：<想对小助理说的话>（会记进你的长期记忆，作为以后的参考）", sources_ok: [], sources_failed: [] };
  }
  const member = resolveMember(request.user_id);
  const memoryUserId = member ? canonicalTimemUserId(member) : request.user_id;
  if (!memoryUserId) {
    return { response: "无法识别你的身份（缺少 user_id），反馈没有写入。", sources_ok: [], sources_failed: ["identity: 缺少 user_id"] };
  }
  let project: ProjectEntry | undefined;
  if (request.project?.trim()) {
    const resolved = resolveProjectRef(getProjectRegistry(), request.project);
    project = resolved.project;
  }
  const content = `【反馈】${project ? `（关于${project.name}）` : ""}${text}`;
  const w = await timemWrite(ctx, {
    content,
    userId: memoryUserId,
    ...(project ? { domain: project.project_id } : {}),
  });
  if (!w.ok) {
    return {
      response: `❌ 反馈写入记忆失败: ${w.error}`,
      sources_ok: [],
      sources_failed: [`timem: ${w.error}`],
    };
  }
  rc.sourcesOk.push("timem");
  const suffix = member
    ? ""
    : "（你的身份还未登记花名册，先记在来源账号名下；登记后可归并）";
  return {
    response: `✅ 反馈已记入你的长期记忆${project ? `（关联项目：${project.name}）` : ""}，之后汇总任务安排时会参考。${suffix}`,
    sources_ok: rc.sourcesOk,
    sources_failed: [],
  };
}

async function runWriteDigest(
  request: Extract<ProjectBriefingRequest, { mode: "write-digest" }>,
  ctx: SeamContext,
  rc: RunCtx,
  deps?: BriefingDeps,
): Promise<ProjectBriefingResponse> {
  const trigger = request.trigger ?? "daily";
  const file = getProjectRegistry();
  let projects: ProjectEntry[];
  if (request.project?.trim()) {
    const p = resolveProjectKey(request.project.trim());
    if (!p) {
      return { response: `未登记项目「${request.project}」，跳过快照。`, sources_ok: [], sources_failed: [`project: ${request.project} 未登记`] };
    }
    projects = [p];
  } else {
    projects = file.projects;
  }

  const written: string[] = [];
  const skipped: string[] = [];

  // ── 项目快照 ──
  for (const p of projects) {
    const scope = projectRepoScope(p);
    const errors: string[] = [];
    const expanded = await expandOrgRepos(ctx, scope.orgs, errors);
    const snaps = await collectRepos(ctx, [...scope.repos, ...expanded]);
    const { tasks, errors: taskErrors } = await collectOrgTasks(ctx, scope.orgs);
    const { logs, errors: logErrors } = await collectLogs(p.log_sources ?? [], deps);
    const text = buildProjectDigestText({
      now: rc.now,
      project: p,
      snaps,
      tasks,
      logs,
      trigger,
      note: request.note,
    });
    const w = await timemWrite(ctx, {
      content: text,
      userId: projectMemoryUserKey(p.project_id),
      domain: p.project_id,
    });
    if (w.ok) written.push(`项目 ${p.name}`);
    else rc.sourcesFailed.push(`${p.project_id}: ${w.error}`);
    void errors;
    void taskErrors;
    void logErrors;
  }

  // ── 个人快照（仓库数据共享一次采集） ──
  const scope = allScope(file);
  const errors: string[] = [];
  const expanded = await expandOrgRepos(ctx, scope.orgs, errors);
  const snaps = await collectRepos(ctx, [...scope.repos, ...expanded]);
  const { tasks } = await collectOrgTasks(ctx, scope.orgs);
  for (const m of identityMembers(getIdentityRegistry())) {
    const slice = issuesForUser(snaps, m.gitea_usernames);
    const pulls = pullsForUser(snaps, m.gitea_usernames);
    const myTasks = tasksForUser(tasks, [m.name, ...m.aliases]);
    const notable = slice.assigned.length + slice.created.length + pulls.length + myTasks.length;
    if (notable === 0 && trigger === "event") continue; // 事件快照不写空人情
    const text = buildMemberDigestText({
      now: rc.now,
      member: m,
      assigned: slice.assigned,
      created: slice.created,
      pulls,
      tasks: myTasks,
      trigger,
    });
    const w = await timemWrite(ctx, { content: text, userId: canonicalTimemUserId(m) });
    if (w.ok) written.push(`个人 ${m.name}`);
    else rc.sourcesFailed.push(`${m.member_id}: ${w.error}`);
    if (notable === 0) skipped.push(m.name);
  }

  const lines = [
    `✅ 快照写入完成（${trigger === "daily" ? "每日定时" : "事件补充"}，${fmtTime(rc.now)}）`,
    `写入 ${written.length} 条: ${written.join("、") || "无"}`,
  ];
  if (skipped.length > 0) lines.push(`无在办事项（空快照已跳过内容明细部分）: ${skipped.join("、")}`);
  if (rc.sourcesFailed.length > 0) lines.push(`⚠️ 失败: ${rc.sourcesFailed.join("；")}`);
  return { response: lines.join("\n"), sources_ok: rc.sourcesOk, sources_failed: rc.sourcesFailed };
}

export const projectBriefingProvider = createProjectBriefingProvider();

// ── 每日定时调度器（装配层接线用） ───────────────────────────────

export interface BriefingDigestScheduler {
  stop(): void;
}

/**
 * 每日 HH:MM 触发 write-digest（进程启动晚于当日触发点时补跑一次）。
 * env: BRIEFING_DIGEST_TIME（默认 18:30）、BRIEFING_DIGEST_ENABLED=0 关闭。
 */
export function startBriefingDigestScheduler(opts: {
  ctx: SeamContext;
  execute: (request: ProjectBriefingRequest, ctx: SeamContext) => Promise<Result<ProjectBriefingResponse>>;
  time?: string;
  enabled?: boolean;
}): BriefingDigestScheduler {
  const enabled = opts.enabled ?? process.env.BRIEFING_DIGEST_ENABLED !== "0";
  if (!enabled) {
    console.log("[briefing] 每日快照调度已关闭 (BRIEFING_DIGEST_ENABLED=0)");
    return { stop() { /* 未启动 */ } };
  }
  const time = opts.time ?? process.env.BRIEFING_DIGEST_TIME ?? "18:30";
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  const hh = m ? Number(m[1]) : 18;
  const mm = m ? Number(m[2]) : 30;
  const target = `${pad2(hh)}:${pad2(mm)}`;
  let lastRunDate = "";

  const tick = (): void => {
    const now = new Date();
    const today = fmtDate(now);
    const cur = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    if (lastRunDate === today) return;
    if (cur < target) return;
    lastRunDate = today;
    console.log(`[briefing] 触发每日快照 (${target})`);
    void opts
      .execute({ mode: "write-digest", trigger: "daily" }, opts.ctx)
      .then((r) => {
        if (r.ok) console.log(`[briefing] ${r.value?.response?.split("\n")[0] ?? "完成"}`);
        else console.error(`[briefing] 每日快照失败: ${r.error}`);
      })
      .catch((e) => console.error(`[briefing] 每日快照异常: ${String(e)}`));
  };

  const timer = setInterval(tick, 60_000);
  // 启动时先检查一次（补跑当日窗口：启动晚于触发点时立即执行）
  tick();
  console.log(`[briefing] 每日快照调度已启动 (${target})`);
  return { stop: () => clearInterval(timer) };
}
