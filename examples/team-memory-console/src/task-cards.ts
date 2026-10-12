/**
 * task-cards — 「每日更新」任务卡片（Done/Todo/Progress/PRs 按人）
 *
 * 2026-10-05 与负责人确认的格式，数据源：
 *   · config/task-registry.local.json   任务台账（复核状态/执行人外键）
 *   · config/timem-team-registry.json   人员台账（member_id/姓名/别名 ↔ Gitea 账号）
 *   · config/project-registry.json      项目 → Gitea 仓库（PR 拉取范围）
 *   · git.aigility.cloud PR API         窗口内的 PR（token 读 ~/.gitea-token）
 *
 * 语义（与复核链一致）：Done=已完结任务+已合并 PR；Todo=planned/ready/failed；
 * Progress=dispatched/running/review + 未合并 PR；PRs=窗口内全部相关 PR。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RegTask {
  uid: string;
  title: string;
  status: string;
  projectRef?: string;
  description?: string;
  assignee_member_id?: string;
  links?: Record<string, { guid?: string; url?: string }>;
  origin?: { provider: string; guid: string };
  /** 落账时间：epoch-ms 数字或 ISO 字符串（台账两种形态并存） */
  updatedAt?: number | string;
}

interface Member {
  member_id: string;
  name: string;
  aliases?: string[];
  gitea_usernames?: string[];
}

interface PrItem {
  repo: string;
  number: number;
  title: string;
  state: string;
  merged: boolean;
  author: string;
  /** author 的归属说明：团队内成员（gitea_usernames 命中）→ "member"，外部作者 → undefined */
  authorName?: string;
  updatedAt: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function loadMembers(): Member[] {
  return readJson<{ members?: Member[] }>(join(ROOT, "config/timem-team-registry.json"), {}).members ?? [];
}

export function loadRegistryTasks(): RegTask[] {
  return readJson<{ tasks?: RegTask[] }>(join(ROOT, "config/task-registry.local.json"), {}).tasks ?? [];
}

function loadProjects(): Array<{ name?: string; gitea_repos?: string[]; gitea_orgs?: string[] }> {
  const reg = readJson<{ projects?: Array<{ name?: string; gitea_repos?: string[]; gitea_orgs?: string[] }> }>(
    join(ROOT, "config/project-registry.json"),
    {},
  );
  return reg.projects ?? [];
}

function loadRepos(): string[] {
  return loadProjects().flatMap((p) => p.gitea_repos ?? []);
}

/** 团队成员的 Gitea 账号（timem-team-registry.json 的 gitea_usernames 字段）——PR 按人归属依据 */
function loadTeamGiteaUsernames(): string[] {
  return loadMembers().flatMap((m) => m.gitea_usernames ?? []);
}

function readGiteaToken(): string {
  const tokenPath = join(process.env["HOME"] ?? "~", ".gitea-token");
  if (!existsSync(tokenPath)) return "";
  return readFileSync(tokenPath, "utf-8").trim();
}

/** 展开 gitea_orgs 为 org/repos（首屏 50 个对当前规模足够；project-registry.json notes 承诺的语义） */
async function expandOrgRepos(orgs: string[]): Promise<string[]> {
  const token = readGiteaToken();
  if (!token || !orgs.length) return [];
  const out: string[] = [];
  for (const org of orgs) {
    try {
      const resp = await fetch(`https://git.aigility.cloud/api/v1/orgs/${org}/repos?limit=50`, {
        headers: { authorization: `token ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) continue;
      const items = (await resp.json()) as Array<{ full_name?: string }>;
      for (const r of items) if (r.full_name) out.push(r.full_name);
    } catch {
      // 单 org 失败不拖垮整卡
    }
  }
  return out;
}

/** PR 拉取范围：显式 gitea_repos + gitea_orgs 展开的仓库（去重）。
 *  排除 aigility-harness 基础设施仓：框架/插件的日常改动不是业务日报的「成果产出」。 */
async function resolveFetchRepos(): Promise<string[]> {
  const projects = loadProjects();
  const explicit = projects.flatMap((p) => p.gitea_repos ?? []);
  const orgs = [...new Set(projects.flatMap((p) => p.gitea_orgs ?? []))];
  const fromOrgs = await expandOrgRepos(orgs);
  return [...new Set([...explicit, ...fromOrgs])].filter(
    (r) => r !== "AIGility-Cloud-Innovation/aigility-harness",
  );
}

function executorText(t: RegTask): string | undefined {
  return t.description?.match(/执行者：(\S+)/)?.[1];
}

/** 任务 → 成员（assignee 外键优先，执行者文本按姓名/别名兜底） */
function memberOfTask(t: RegTask, members: Member[]): Member | undefined {
  if (t.assignee_member_id) return members.find((m) => m.member_id === t.assignee_member_id);
  const token = executorText(t);
  if (!token) return undefined;
  const tl = token.toLowerCase();
  return members.find((m) =>
    [m.name, m.member_id, ...(m.aliases ?? [])].some((v) => (v ?? "").toLowerCase() === tl),
  );
}

/** 窗口内相关 PR：merged 按北京时间落日（merged_at），其余（open/未合）按 updated_at 兜底。
 *  口径（2026-10-12 拍板）：merged=成果证据，open=在途预告；评论/审查动态不进日报。
 *  author 的 Gitea 账号：同时返回团队内归属（registry gitea_usernames 精确匹配）与原文。 */
async function fetchRecentPrs(
  windowStartIso: string,
  teamGiteaUsernames: string[] = loadTeamGiteaUsernames(),
): Promise<PrItem[]> {
  const token = readGiteaToken();
  if (!token) return [];
  const startMs = new Date(`${windowStartIso}+08:00`).getTime();
  if (!Number.isFinite(startMs)) return [];
  const team = new Set(teamGiteaUsernames);
  const out: PrItem[] = [];
  for (const repo of await resolveFetchRepos()) {
    try {
      const resp = await fetch(
        `https://git.aigility.cloud/api/v1/repos/${repo}/pulls?state=all&sort=updated&limit=20`,
        { headers: { authorization: `token ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!resp.ok) continue;
      const items = (await resp.json()) as Array<{
        number: number;
        title: string;
        state: string;
        merged?: boolean;
        merged_at?: string;
        created_at?: string;
        updated_at?: string;
        user?: { login?: string };
      }>;
      for (const p of items) {
        // merged 优先用 merged_at 判窗口，避免「几天前合并、今天被评论」误报为今日成果
        const ts = p.merged && p.merged_at ? p.merged_at : (p.updated_at ?? "");
        if (!ts || new Date(`${ts.slice(0, 19)}+08:00`).getTime() < startMs) continue;
        out.push({
          repo,
          number: p.number,
          title: p.title ?? `#${p.number}`,
          state: p.state ?? "open",
          merged: Boolean(p.merged),
          author: p.user?.login ?? "",
          authorName: team.has(p.user?.login ?? "") ? "member" : undefined,
          updatedAt: p.updated_at ?? "",
        });
      }
    } catch {
      // 单仓库失败不拖垮整卡
    }
  }
  return out;
}

function prLabel(p: PrItem): string {
  const short = p.repo.split("/")[1];
  return `${short}#${p.number} ${p.title.slice(0, 36)}（${p.merged ? "已合并" : p.state === "open" ? "Open" : p.state}）`;
}

/** 生成「每日更新」任务卡片文本；无数据返回空串（调用方自行跳过） */
export async function buildTaskCards(date: string): Promise<string> {
  const windowStartIso = `${date}T00:00:00`;
  const members = loadMembers();
  const tasks = loadRegistryTasks().filter((t) => t.status !== "done" || true); // 全量，按人分组
  const prs = await fetchRecentPrs(windowStartIso);

  // 归人：任务按执行人外键/文本；PR 按作者 gitea 账号。无关人合并进"未指派/其他"
  const byMember = new Map<string, { member?: Member; tasks: RegTask[]; prs: PrItem[] }>();
  const bucket = (key: string, member?: Member) => {
    if (!byMember.has(key)) byMember.set(key, { member, tasks: [], prs: [] });
    return byMember.get(key)!;
  };
  const keyOfMember = (m: Member) => m.member_id;

  for (const t of tasks) {
    const m = memberOfTask(t, members);
    const key = m ? keyOfMember(m) : `unassigned:${executorText(t) ?? "none"}`;
    bucket(key, m).tasks.push(t);
  }
  for (const p of prs) {
    const m = members.find((mm) => (mm.gitea_usernames ?? []).includes(p.author));
    bucket(m ? keyOfMember(m) : `pr-author:${p.author}`, m).prs.push(p);
  }

  const lines: string[] = ["📊 每日更新 · 项目任务"];
  let cardCount = 0;
  for (const [, bucketItem] of byMember) {
    const name = bucketItem.member?.name ?? bucketItem.tasks[0]?.description?.match(/执行者：(\S+)/)?.[1]
      ?? bucketItem.prs[0]?.author ?? "未指派";
    const done: string[] = [];
    const todo: string[] = [];
    const progress: string[] = [];
    const prLines: string[] = [];

    for (const t of bucketItem.tasks) {
      const label = `${t.title.slice(0, 40)}${t.projectRef ? `（${t.projectRef}）` : ""}`;
      if (t.status === "done") done.push(label);
      else if (t.status === "dispatched" || t.status === "running" || t.status === "review") progress.push(label);
      else todo.push(label);
    }
    for (const p of bucketItem.prs) {
      prLines.push(prLabel(p));
      if (p.merged) done.push(`PR ${p.repo.split("/")[1]}#${p.number} 已合并`);
      else if (p.state === "open") progress.push(`PR ${p.repo.split("/")[1]}#${p.number} 进行中`);
    }

    if (!done.length && !todo.length && !progress.length && !prLines.length) continue;
    cardCount += 1;
    lines.push("", `■ ${name}`);
    lines.push("Done：");
    lines.push(...(done.length ? done.map((d) => `- ${d}`) : ["-（无）"]));
    lines.push("Todo：");
    lines.push(...(todo.length ? todo.map((d) => `- ${d}`) : ["-（无）"]));
    lines.push("Progress：");
    lines.push(...(progress.length ? progress.map((d) => `- ${d}`) : ["-（无）"]));
    lines.push("PRs：");
    lines.push(...(prLines.length ? prLines.map((d) => `- ${d}`) : ["-（无）"]));
  }
  if (cardCount === 0) return "";
  lines.push("", "—— 项目小助理 · 数据源：任务台账 + 人员台账 + Gitea");
  return lines.join("\n");
}

// ── 紧凑工作日报（2026-10-08，负责人拍板的格式）──────────────────
// 按项目（done/doing/todo 概括）+ 按人（任务概括 + 记忆概括），
// 替代此前的"LLM 罗列 + 任务卡片堆叠"冗长格式。

export function loadProjectNames(): Map<string, string> {
  const reg = readJson<{ projects?: Array<{ name?: string; gitea_repos?: string[] }> }>(
    join(ROOT, "config/project-registry.json"),
    {},
  );
  const map = new Map<string, string>();
  for (const p of reg.projects ?? []) {
    for (const repo of p.gitea_repos ?? []) map.set(repo, p.name ?? repo);
  }
  return map;
}

/** 项目阶段目标（config/project-registry.json 的 stage_goal，可选；缺省省略该行） */
export function loadProjectGoals(): Map<string, string> {
  const reg = readJson<{ projects?: Array<{ name?: string; stage_goal?: string; gitea_repos?: string[] }> }>(
    join(ROOT, "config/project-registry.json"),
    {},
  );
  const map = new Map<string, string>();
  for (const p of reg.projects ?? []) {
    const goal = (p.stage_goal ?? "").trim();
    if (!goal) continue;
    if (p.name) map.set(p.name, goal);
    for (const repo of p.gitea_repos ?? []) map.set(repo, goal);
  }
  return map;
}

const RISK_STALE_DAYS = 7;
const RISK_OVERLOAD_TASKS = 6;

/** 台账 updatedAt → epoch ms（兼容 epoch 秒/毫秒与 ISO 字符串；缺省/解析失败返回 null） */
export function taskUpdatedAtMs(t: RegTask): number | null {
  const v = t.updatedAt;
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v > 1e12 ? v : v * 1000;
  }
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 日报任务口径（2026-10-12 负责人拍板）：done 且当天更新过 = 当天完成，不新增 completedAt 字段。
 *  非 done 状态按当前进展照常呈现；done 但非当天更新（历史完成，前天/更早落账）不进当天日报。 */
export function filterTasksForDaily(tasks: RegTask[], date: string): RegTask[] {
  const startMs = new Date(`${date}T00:00:00`).getTime();
  const endMs = startMs + 86_400_000;
  return tasks.filter((t) => {
    if (t.status !== "done") return true;
    const ms = taskUpdatedAtMs(t);
    return ms != null && ms >= startMs && ms < endMs;
  });
}

/** 人员块的工作风险（确定性推导，按项目归组，不编造）：
 *  ① 受阻/失败任务 ② doing 放置超过 7 天 ③ 并行任务过多 */
export function memberRiskSummary(
  tks: RegTask[],
  projectNames: Map<string, string>,
  now = Date.now(),
): string | null {
  if (!tks.length) return null;
  const parts: string[] = [];
  const blocked = tks.filter((t) => t.status === "failed" || t.status === "blocked");
  if (blocked.length) {
    const head = blocked.slice(0, 2).map((t) => t.title.replace(/^\[[^\]]+\]\s*/, "").replace(/^【[^】]+】/, "").slice(0, 20));
    parts.push(`受阻/失败 ${blocked.length} 项（${head.join("、")}）`);
  }
  const staleByProject = new Map<string, number>();
  let staleMax = 0;
  for (const t of tks) {
    if (!["dispatched", "running", "review"].includes(t.status)) continue;
    const ts = (t as RegTask & { updatedAt?: number; createdAt?: number }).updatedAt
      ?? (t as RegTask & { createdAt?: number }).createdAt;
    if (!ts) continue;
    const days = Math.floor((now - ts) / 86_400_000);
    if (days < RISK_STALE_DAYS) continue;
    const key = projectNames.get(t.projectRef ?? "") ?? t.projectRef ?? "（未定仓库）";
    staleByProject.set(key, (staleByProject.get(key) ?? 0) + 1);
    staleMax = Math.max(staleMax, days);
  }
  for (const [proj, n] of staleByProject) parts.push(`${proj} ${n} 项 ${staleMax} 天未动`);
  if (tks.length >= RISK_OVERLOAD_TASKS) parts.push(`并行任务 ${tks.length} 项`);
  return parts.length ? parts.join("；").slice(0, 90) : null;
}

const COMPACT_BUCKET: Record<string, "done" | "doing" | "todo"> = {
  done: "done", dispatched: "doing", running: "doing", review: "doing",
  planned: "todo", ready: "todo", failed: "todo", blocked: "todo",
};

function compactSummarize(items: RegTask[]): string {
  if (!items.length) return "无";
  const head = items
    .slice(0, 2)
    .map((t) => t.title.replace(/^\[[^\]]+\]\s*/, "").replace(/^【[^】]+】/, "").slice(0, 28));
  return `${items.length} 项（${head.join("、")}${items.length > 2 ? " 等" : ""}）`;
}

/** 对外显示名：登记名是中文直接用；否则取首个中文别名（取空格前部分），如 xubincheng→徐彬程 */
function displayName(m: Member): string {
  if (/[\u4e00-\u9fa5]/.test(m.name)) return m.name;
  const zh = (m.aliases ?? []).find((a) => /^[\u4e00-\u9fa5]/.test(a));
  return zh ? zh.split(/\s+/)[0] : m.name;
}

/** 人名对照块：告诉 LLM 哪些称呼是同一人，输出必须合并成一行、统一用显示名 */
function nameRoster(members: Member[]): string[] {
  return members.map((m) => {
    const callings = [...new Set([displayName(m), m.name, ...(m.aliases ?? [])].filter(Boolean))];
    return `- ${displayName(m)}＝${callings.join("／")}`;
  });
}

/** 生成紧凑工作日报文本：按项目 done/doing/todo + 按人 任务/记忆概括 */
export function renderCompactDaily(
  date: string,
  tasks: RegTask[],
  prs: PrItem[],
  memoriesByMember: Array<{ memberName: string; count: number; sample?: string }>,
): string {
  const members = loadMembers();
  const projectNames = loadProjectNames();
  const projectGoals = loadProjectGoals();

  // ── 按项目 ──（分组键 = 项目显示名：同一项目的多个仓库合并为一节）
  const lines: string[] = [`📋 工作日报 · ${date}（总结）`, ""];
  lines.push("按项目");
  const byProject = new Map<string, RegTask[]>();
  for (const t of tasks) {
    const repo = t.projectRef ?? "（未定仓库）";
    const key = projectNames.get(repo) ?? repo;
    byProject.set(key, [...(byProject.get(key) ?? []), t]);
  }
  const prsByProject = new Map<string, PrItem[]>();
  for (const p of prs) {
    const key = projectNames.get(p.repo) ?? p.repo.split("/")[1] ?? p.repo;
    prsByProject.set(key, [...(prsByProject.get(key) ?? []), p]);
  }
  const projKeys = [...new Set([...byProject.keys(), ...prsByProject.keys()])]
    .sort((a, b) => ((byProject.get(b)?.length ?? 0) + (prsByProject.get(b)?.length ?? 0))
      - ((byProject.get(a)?.length ?? 0) + (prsByProject.get(a)?.length ?? 0)));
  for (const name of projKeys) {
    const ts = byProject.get(name) ?? [];
    const prsOf = prsByProject.get(name) ?? [];
    if (!ts.length && !prsOf.length) continue;
    const buckets: Record<"done" | "doing" | "todo", RegTask[]> = { done: [], doing: [], todo: [] };
    for (const t of ts) (buckets[COMPACT_BUCKET[t.status] ?? "todo"]).push(t);
    const mergedN = prsOf.filter((p) => p.merged).length;
    const openN = prsOf.length - mergedN;
    lines.push(`- ${name}：`);
    const goal = projectGoals.get(name);
    if (goal) lines.push(`  - 阶段目标：${goal}`);
    const doneParts = [
      buckets.done.length ? compactSummarize(buckets.done) : null,
      mergedN ? `合并 PR ${mergedN} 个` : null,
    ].filter(Boolean);
    lines.push(`  - done：${doneParts.length ? doneParts.join("；") : "无"}`);
    lines.push(`  - doing：${buckets.doing.length ? compactSummarize(buckets.doing) : openN ? `在途 PR ${openN} 个` : "无"}`);
    lines.push(`  - 与目标差距：还差 ${buckets.todo.length ? compactSummarize(buckets.todo) : "无"}`);
  }

  // ── 按人（含按项目归组的工作风险，确定性推导不编造）──
  lines.push("", "按人");
  let personCount = 0;
  for (const m of members) {
    const tks = tasks.filter((t) => memberOfTask(t, [m]));
    const mem = memoriesByMember.find((x) => x.memberName === m.name);
    const risk = memberRiskSummary(tks, projectNames);
    // PR 归人：author 的 Gitea 账号精确命中 registry 的 gitea_usernames
    const myPrs = prs.filter((p) => (m.gitea_usernames ?? []).includes(p.author));
    const myMerged = myPrs.filter((p) => p.merged).length;
    const myOpen = myPrs.length - myMerged;
    if (!tks.length && !(mem && mem.count) && !risk && !myPrs.length) continue;
    const done = tks.filter((t) => t.status === "done");
    const doing = tks.filter((t) => ["dispatched", "running", "review"].includes(t.status));
    const todo = tks.filter((t) => !["done", "dispatched", "running", "review"].includes(t.status));
    lines.push(`- ${displayName(m)}：`);
    if (tks.length) lines.push(`  - 任务：${compactSummarize(tks)}（done ${done.length} / doing ${doing.length} / todo ${todo.length}）`);
    if (mem && mem.count) lines.push(`  - 记忆：今日 ${mem.count} 条${mem.sample ? `（${mem.sample}）` : ""}`);
    if (myPrs.length) {
      const parts = [
        myMerged ? `合并 ${myMerged}` : null,
        myOpen ? `在途 ${myOpen}` : null,
      ].filter(Boolean);
      const head = myPrs.slice(0, 2).map((p) => prLabel(p)).join("；");
      lines.push(`  - PR：${parts.join("/")}（${head}${myPrs.length > 2 ? " 等" : ""}）`);
    }
    if (risk) lines.push(`  - 工作风险：${risk}`);
    personCount += 1;
  }
  if (personCount === 0) lines.push("（今日无人员动态）");
  lines.push("", "—— 项目小助理 · 数据源：任务台账 + Gitea + 太忆空间");
  return lines.join("\n");
}

/** 紧凑工作日报入口（异步：内部拉取窗口内 PR）
 *  done 过滤按日收口（2026-10-12）：只报当天完成，历史 done 不再每天重报。 */
export async function buildCompactDailyReport(
  date: string,
  memoriesByMember: Array<{ memberName: string; count: number; sample?: string }>,
): Promise<string> {
  const tasks = filterTasksForDaily(
    loadRegistryTasks().filter((t) => t.status !== "cancelled"),
    date,
  );
  const prs = await fetchRecentPrs(`${date}T00:00:00`);
  return renderCompactDaily(date, tasks, prs, memoriesByMember);
}

/** 紧凑工作晨报（2026-10-09，对齐日报风格）：只呈现 todo —— 按项目（今日待办）+ 按人（待办 + 计划线索） */
export function renderCompactMorning(
  date: string,
  tasks: RegTask[],
  planMemoriesByMember: Array<{ memberName: string; count: number; sample?: string }>,
): string {
  const members = loadMembers();
  const projectNames = loadProjectNames();
  const projectGoals = loadProjectGoals();

  const lines: string[] = [
    `🌅 工作晨报 · ${date}（计划 · 尚未完成）`,
    "⚠️ 性质声明：本晨报全部为「计划 / 进行中」状态，不是已完成事项；完成情况以当日《工作日报》为准。",
    "",
  ];
  // ── 按项目：台账梳理 = 今日待办 + 进行中（2026-10-12 负责人拍板：晨报按项目补台账进展）──
  lines.push("按项目 · 计划梳理（进行中 + 今日待办，均非已完成）");
  const todoOf = new Map<string, RegTask[]>();
  const doingOf = new Map<string, RegTask[]>();
  for (const t of tasks) {
    const b = COMPACT_BUCKET[t.status];
    if (b !== "todo" && b !== "doing") continue;
    const repo = t.projectRef ?? "（未定仓库）";
    const key = projectNames.get(repo) ?? repo;
    const map = b === "todo" ? todoOf : doingOf;
    map.set(key, [...(map.get(key) ?? []), t]);
  }
  const projKeys = [...new Set([...todoOf.keys(), ...doingOf.keys()])]
    .sort((a, b) => ((doingOf.get(b)?.length ?? 0) + (todoOf.get(b)?.length ?? 0)) - ((doingOf.get(a)?.length ?? 0) + (todoOf.get(a)?.length ?? 0)));
  for (const name of projKeys) {
    const ts = todoOf.get(name) ?? [];
    const doing = doingOf.get(name);
    if (ts.length) lines.push(`- ${name}：${compactSummarize(ts)}`);
    else lines.push(`- ${name}：今日无待办${doing?.length ? `，推进中 ${doing.length} 项` : ""}`);
    if (doing?.length) lines.push(`  - 进行中：${compactSummarize(doing)}`);
    const goal = projectGoals.get(name);
    if (goal) lines.push(`  - 阶段目标：${goal}`);
  }
  if (!projKeys.length) lines.push("（各项目暂无待办与进行中任务）");

  // ── 按人：今日待办 + 近 3 天计划线索 + 按项目工作风险 ──
  lines.push("", "按人 · 计划（今日待办，非已完成）");
  let personCount = 0;
  for (const m of members) {
    const tks = tasks.filter((t) => memberOfTask(t, [m]));
    const todo = tks.filter((t) => COMPACT_BUCKET[t.status] === "todo");
    const plan = planMemoriesByMember.find((x) => x.memberName === m.name);
    const risk = memberRiskSummary(tks, projectNames);
    if (!todo.length && !(plan && plan.count) && !risk) continue;
    lines.push(`- ${displayName(m)}：`);
    if (todo.length) lines.push(`  - 待办：${compactSummarize(todo)}`);
    if (plan && plan.count) lines.push(`  - 计划线索：近 3 天 ${plan.count} 条${plan.sample ? `（${plan.sample}）` : ""}`);
    if (risk) lines.push(`  - 工作风险：${risk}`);
    personCount += 1;
  }
  if (!personCount) lines.push("（暂无人员待办）");
  lines.push("", "—— 项目小助理 · 晨报=计划快照（进行中/待办，非已完成） · 数据源：任务台账 + 太忆空间计划记忆（完成情况见当日日报）");
  return lines.join("\n");
}

/** 紧凑工作晨报入口（结构化部分确定性生成，LLM 综述由调用方负责） */
export async function buildCompactMorningReport(
  date: string,
  planMemoriesByMember: Array<{ memberName: string; count: number; sample?: string }>,
): Promise<string> {
  const tasks = loadRegistryTasks().filter((t) => t.status !== "cancelled");
  return renderCompactMorning(date, tasks, planMemoriesByMember);
}

// ── LLM 综述输入物料（2026-10-09）：输出改为结构化罗列，输入也要放宽 ——
// 标题不再截 28 字（80 字）、带执行人、每人附多条记忆线索，让综述有料可概括。

type MemHint = { memberName: string; count: number; sample?: string; samples?: string[] };

/** 任务状态标签（物料层打标，LLM 据此分「完成/未完成」，与 COMPACT_BUCKET 同源） */
const BRIEFING_STATUS_TAG: Record<string, string> = {
  done: "[完成]", dispatched: "[进行中]", running: "[进行中]", review: "[进行中]",
  planned: "[待办]", ready: "[待办]", failed: "[受阻]", blocked: "[受阻]",
};

function briefingTaskLine(t: RegTask, members: Member[]): string {
  const who = memberOfTask(t, members);
  const title = t.title.replace(/^\[[^\]]+\]\s*/, "").replace(/^【[^】]+】/, "").replace(/\s+/g, " ").slice(0, 80);
  const tag = BRIEFING_STATUS_TAG[t.status] ?? "";
  return `${tag ? `${tag} ` : ""}${title}${who ? `（执行人 ${displayName(who)}）` : ""}`;
}

function briefingPeopleSection(
  tasks: RegTask[],
  memoriesByMember: MemHint[],
  memLine: (hint: MemHint) => string | null,
): string[] {
  const members = loadMembers();
  const lines: string[] = [];
  for (const m of members) {
    // 2026-10-09 分档：台账指派（确证有人指派）与记忆线索（与他相关 ≠ 他要做）
    // 分行输出，让 LLM 在正文里保住可靠度差异，不把"他安排别人的"写成"他要做的"。
    const tks = tasks.filter((t) => memberOfTask(t, [m]));
    if (tks.length) {
      lines.push(`- ${displayName(m)} · 台账指派：${tks.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    }
    const hint = memoriesByMember.find((x) => x.memberName === m.name);
    const memPart = memLine(hint ?? { memberName: m.name, count: 0 });
    if (memPart) lines.push(`- ${displayName(m)} · 记忆线索：${memPart}`);
  }
  return lines;
}

/** Gitea 账号 → 团队显示名（registry gitea_usernames 精确匹配；未登记返回 null） */
function memberNameByGiteaLogin(login: string): string | null {
  for (const m of loadMembers()) {
    if ((m.gitea_usernames ?? []).includes(login)) return displayName(m);
  }
  return null;
}

/** 日报 LLM 输入：按项目（阶段目标/完成/进行中/待办 全行，任务带状态标签）+ PR 动态 + 按人（台账/记忆分行带状态标签） */
export function renderDailyBriefing(
  tasks: RegTask[],
  prs: PrItem[],
  memoriesByMember: MemHint[],
): string {
  const projectNames = loadProjectNames();
  const lines: string[] = [];
  const byProject = new Map<string, RegTask[]>();
  for (const t of tasks) {
    const key = projectNames.get(t.projectRef ?? "") ?? t.projectRef ?? "（未定仓库）";
    byProject.set(key, [...(byProject.get(key) ?? []), t]);
  }
  lines.push("【按项目】");
  const projectGoals = loadProjectGoals();
  for (const [name, ts] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bucket = (b: "done" | "doing" | "todo") => ts.filter((t) => COMPACT_BUCKET[t.status] === b);
    const members = loadMembers();
    const done = bucket("done"), doing = bucket("doing"), todo = bucket("todo");
    lines.push(`- ${name}：`);
    const goal = projectGoals.get(name);
    if (goal) lines.push(`  阶段目标：${goal}`);
    if (done.length) lines.push(`  完成：${done.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    if (doing.length) lines.push(`  进行中：${doing.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    if (todo.length) lines.push(`  待办：${todo.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
  }
  if (prs.length) {
    lines.push("", "【PR 动态】（已合并=成果证据；在途=进行中预告，禁止写成已完成）");
    const projectNamesForPr = loadProjectNames();
    for (const p of prs.slice(0, 15)) {
      const proj = projectNamesForPr.get(p.repo) ?? p.repo.split("/")[1] ?? p.repo;
      const who = memberNameByGiteaLogin(p.author) ?? p.author;
      const status = p.merged ? "已合并" : "在途";
      lines.push(`- ${proj} #${p.number} ${p.title.replace(/\s+/g, " ").slice(0, 60)}（${who}，${status}）`);
    }
  }
  lines.push("", "【按人】", ...briefingPeopleSection(
    tasks, memoriesByMember,
    (h) => (h.count ? (h.samples ?? [h.sample]).filter(Boolean).slice(0, 2).join(" / ") : null),
  ));
  // 工作风险（确定性推导，按项目归组，供 LLM 在对应人/项目行尾点出）
  const projectNamesForRisk = loadProjectNames();
  const riskLines: string[] = [];
  for (const m of loadMembers()) {
    const risk = memberRiskSummary(tasks.filter((t) => memberOfTask(t, [m])), projectNamesForRisk);
    if (risk) riskLines.push(`- ${displayName(m)}：${risk}`);
  }
  if (riskLines.length) lines.push("", "【工作风险】（按项目归组，来自台账状态推导）", ...riskLines);
  lines.push("", "【人名对照】（＝左右是同一人，输出必须合并为一行，姓名统一用＝左边）", ...nameRoster(loadMembers()));
  return lines.join("\n");
}

/** 晨报 LLM 输入：按项目（台账梳理=进行中+今日待办 全行）+ 按人（待办 + 近 3 天计划线索） */
export function renderMorningBriefing(
  tasks: RegTask[],
  planMemoriesByMember: MemHint[],
): string {
  const projectNames = loadProjectNames();
  const lines: string[] = [];
  // 2026-10-12 负责人拍板：晨报按项目补台账梳理——进行中任务与今日待办都给，
  // 让晨报交代各项目当前推进状态，而非只列今日待办。
  const doingOf = new Map<string, RegTask[]>();
  const todoOf = new Map<string, RegTask[]>();
  for (const t of tasks) {
    const b = COMPACT_BUCKET[t.status];
    if (b !== "todo" && b !== "doing") continue;
    const key = projectNames.get(t.projectRef ?? "") ?? t.projectRef ?? "（未定仓库）";
    const map = b === "todo" ? todoOf : doingOf;
    map.set(key, [...(map.get(key) ?? []), t]);
  }
  lines.push("【按项目 · 计划梳理】（以下均为进行中/待办，非已完成；[完成] 标记仅供参考，禁止写进晨报正文）");
  const projectGoals = loadProjectGoals();
  const projKeys = [...new Set([...todoOf.keys(), ...doingOf.keys()])]
    .sort((a, b) => ((doingOf.get(b)?.length ?? 0) + (todoOf.get(b)?.length ?? 0)) - ((doingOf.get(a)?.length ?? 0) + (todoOf.get(a)?.length ?? 0)));
  for (const name of projKeys) {
    const members = loadMembers();
    const ts = todoOf.get(name) ?? [];
    const doing = doingOf.get(name) ?? [];
    lines.push(`- ${name}：今日待办：${ts.length ? ts.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；") : "无"}`);
    if (doing.length) lines.push(`  进行中：${doing.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    const goal = projectGoals.get(name);
    if (goal) lines.push(`  阶段目标：${goal}`);
  }
  if (!projKeys.length) lines.push("（各项目暂无待办与进行中任务）");
  lines.push("", "【按人 · 计划】（以下为各人今日待办/进行中，非已完成）", ...briefingPeopleSection(
    tasks, planMemoriesByMember,
    (h) => (h.count ? (h.samples ?? [h.sample]).filter(Boolean).slice(0, 3).join(" / ") : null),
  ));
  // 工作风险（确定性推导，供 LLM 在按人行尾带出）
  const membersAll = loadMembers();
  const riskLines: string[] = [];
  for (const m of membersAll) {
    const risk = memberRiskSummary(tasks.filter((t) => memberOfTask(t, [m])), loadProjectNames());
    if (risk) riskLines.push(`- ${displayName(m)}：${risk}`);
  }
  if (riskLines.length) lines.push("", "【工作风险】（按项目归组，来自台账状态推导）", ...riskLines);
  lines.push("", "【人名对照】（＝左右是同一人，输出必须合并为一行，姓名统一用＝左边）", ...nameRoster(loadMembers()));
  return lines.join("\n");
}

export async function buildDailyBriefing(date: string, memoriesByMember: MemHint[]): Promise<string> {
  const tasks = filterTasksForDaily(
    loadRegistryTasks().filter((t) => t.status !== "cancelled"),
    date,
  );
  const prs = await fetchRecentPrs(`${date}T00:00:00`);
  return renderDailyBriefing(tasks, prs, memoriesByMember);
}

export async function buildMorningBriefing(date: string, planMemories: MemHint[]): Promise<string> {
  const tasks = loadRegistryTasks().filter((t) => t.status !== "cancelled");
  return renderMorningBriefing(tasks, planMemories);
}
