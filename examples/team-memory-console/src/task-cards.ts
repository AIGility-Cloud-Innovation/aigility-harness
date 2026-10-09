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

function loadRepos(): string[] {
  const reg = readJson<{ projects?: Array<{ gitea_repos?: string[] }> }>(
    join(ROOT, "config/project-registry.json"),
    {},
  );
  return (reg.projects ?? []).flatMap((p) => p.gitea_repos ?? []);
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

async function fetchRecentPrs(windowStartIso: string): Promise<PrItem[]> {
  const tokenPath = join(process.env["HOME"] ?? "~", ".gitea-token");
  if (!existsSync(tokenPath)) return [];
  const token = readFileSync(tokenPath, "utf-8").trim();
  const out: PrItem[] = [];
  for (const repo of loadRepos()) {
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
        updated_at?: string;
        user?: { login?: string };
      }>;
      for (const p of items) {
        if ((p.updated_at ?? "") < windowStartIso) continue;
        out.push({
          repo,
          number: p.number,
          title: p.title ?? `#${p.number}`,
          state: p.state ?? "open",
          merged: Boolean(p.merged),
          author: p.user?.login ?? "",
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

  // ── 按项目 ──（分组键 = 项目显示名：同一项目的多个仓库合并为一节）
  const lines: string[] = [`📋 工作日报 · ${date}`, ""];
  lines.push("按项目");
  const byProject = new Map<string, RegTask[]>();
  for (const t of tasks) {
    const repo = t.projectRef ?? "（未定仓库）";
    const key = projectNames.get(repo) ?? repo;
    byProject.set(key, [...(byProject.get(key) ?? []), t]);
  }
  for (const [repo, ts] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const buckets: Record<"done" | "doing" | "todo", RegTask[]> = { done: [], doing: [], todo: [] };
    for (const t of ts) (buckets[COMPACT_BUCKET[t.status] ?? "todo"]).push(t);
    lines.push(`- ${projectNames.get(repo) ?? repo}：`);
    lines.push(`  - done：${compactSummarize(buckets.done)}`);
    lines.push(`  - doing：${compactSummarize(buckets.doing)}`);
    lines.push(`  - todo：${compactSummarize(buckets.todo)}`);
  }

  // ── 按人 ──
  lines.push("", "按人");
  let personCount = 0;
  for (const m of members) {
    const tks = tasks.filter((t) => memberOfTask(t, [m]));
    const mem = memoriesByMember.find((x) => x.memberName === m.name);
    if (!tks.length && !(mem && mem.count)) continue;
    const done = tks.filter((t) => t.status === "done");
    const doing = tks.filter((t) => ["dispatched", "running", "review"].includes(t.status));
    const todo = tks.filter((t) => !["done", "dispatched", "running", "review"].includes(t.status));
    lines.push(`- ${displayName(m)}：`);
    if (tks.length) lines.push(`  - 任务：${compactSummarize(tks)}（done ${done.length} / doing ${doing.length} / todo ${todo.length}）`);
    if (mem && mem.count) lines.push(`  - 记忆：今日 ${mem.count} 条${mem.sample ? `（${mem.sample}）` : ""}`);
    personCount += 1;
  }
  if (personCount === 0) lines.push("（今日无人员动态）");
  lines.push("", "—— 项目小助理 · 数据源：任务台账 + Gitea + 太忆空间");
  return lines.join("\n");
}

/** 紧凑工作日报入口（异步：内部拉取窗口内 PR） */
export async function buildCompactDailyReport(
  date: string,
  memoriesByMember: Array<{ memberName: string; count: number; sample?: string }>,
): Promise<string> {
  const tasks = loadRegistryTasks().filter((t) => t.status !== "cancelled");
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

  const lines: string[] = [`🌅 工作晨报 · ${date}`, ""];
  // ── 按项目：今日待办 ──
  lines.push("按项目 · 今日待办");
  const todoOf = new Map<string, RegTask[]>();
  for (const t of tasks) {
    if (COMPACT_BUCKET[t.status] !== "todo") continue;
    const repo = t.projectRef ?? "（未定仓库）";
    const key = projectNames.get(repo) ?? repo;
    todoOf.set(key, [...(todoOf.get(key) ?? []), t]);
  }
  for (const [name, ts] of [...todoOf.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`- ${name}：${compactSummarize(ts)}`);
  }
  if (!todoOf.size) lines.push("（各项目暂无待办）");

  // ── 按人：今日待办 + 近 3 天计划线索 ──
  lines.push("", "按人 · 今日待办");
  let personCount = 0;
  for (const m of members) {
    const todo = tasks.filter((t) => memberOfTask(t, [m]) && COMPACT_BUCKET[t.status] === "todo");
    const plan = planMemoriesByMember.find((x) => x.memberName === m.name);
    if (!todo.length && !(plan && plan.count)) continue;
    lines.push(`- ${displayName(m)}：`);
    if (todo.length) lines.push(`  - 待办：${compactSummarize(todo)}`);
    if (plan && plan.count) lines.push(`  - 计划线索：近 3 天 ${plan.count} 条${plan.sample ? `（${plan.sample}）` : ""}`);
    personCount += 1;
  }
  if (!personCount) lines.push("（暂无人员待办）");
  lines.push("", "—— 项目小助理 · 数据源：任务台账 + 太忆空间计划记忆");
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

function briefingTaskLine(t: RegTask, members: Member[]): string {
  const who = memberOfTask(t, members);
  const title = t.title.replace(/^\[[^\]]+\]\s*/, "").replace(/^【[^】]+】/, "").replace(/\s+/g, " ").slice(0, 80);
  return `${title}${who ? `（执行人 ${displayName(who)}）` : ""}`;
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

/** 日报 LLM 输入：按项目（完成/进行/待办 全行）+ PR 动态 + 按人 */
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
  for (const [name, ts] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bucket = (b: "done" | "doing" | "todo") => ts.filter((t) => COMPACT_BUCKET[t.status] === b);
    const members = loadMembers();
    const done = bucket("done"), doing = bucket("doing"), todo = bucket("todo");
    lines.push(`- ${name}：`);
    if (done.length) lines.push(`  完成：${done.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    if (doing.length) lines.push(`  进行中：${doing.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
    if (todo.length) lines.push(`  待办：${todo.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
  }
  if (prs.length) {
    lines.push("", "【PR 动态】");
    for (const p of prs.slice(0, 10)) {
      lines.push(`- ${p.repo}#${p.number} ${p.title.replace(/\s+/g, " ").slice(0, 60)}（${p.author}${p.merged ? "，已合并" : ""}）`);
    }
  }
  lines.push("", "【按人】", ...briefingPeopleSection(
    tasks, memoriesByMember,
    (h) => (h.count ? (h.samples ?? [h.sample]).filter(Boolean).slice(0, 2).join(" / ") : null),
  ));
  lines.push("", "【人名对照】（＝左右是同一人，输出必须合并为一行，姓名统一用＝左边）", ...nameRoster(loadMembers()));
  return lines.join("\n");
}

/** 晨报 LLM 输入：按项目（今日待办全行）+ 按人（待办 + 近 3 天计划线索） */
export function renderMorningBriefing(
  tasks: RegTask[],
  planMemoriesByMember: MemHint[],
): string {
  const projectNames = loadProjectNames();
  const lines: string[] = [];
  const todoOf = new Map<string, RegTask[]>();
  for (const t of tasks) {
    if (COMPACT_BUCKET[t.status] !== "todo") continue;
    const key = projectNames.get(t.projectRef ?? "") ?? t.projectRef ?? "（未定仓库）";
    todoOf.set(key, [...(todoOf.get(key) ?? []), t]);
  }
  lines.push("【按项目】");
  for (const [name, ts] of [...todoOf.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const members = loadMembers();
    lines.push(`- ${name}：${ts.slice(0, 8).map((t) => briefingTaskLine(t, members)).join("；")}`);
  }
  if (!todoOf.size) lines.push("（各项目暂无待办）");
  lines.push("", "【按人】", ...briefingPeopleSection(
    tasks, planMemoriesByMember,
    (h) => (h.count ? (h.samples ?? [h.sample]).filter(Boolean).slice(0, 3).join(" / ") : null),
  ));
  lines.push("", "【人名对照】（＝左右是同一人，输出必须合并为一行，姓名统一用＝左边）", ...nameRoster(loadMembers()));
  return lines.join("\n");
}

export async function buildDailyBriefing(date: string, memoriesByMember: MemHint[]): Promise<string> {
  const tasks = loadRegistryTasks().filter((t) => t.status !== "cancelled");
  const prs = await fetchRecentPrs(`${date}T00:00:00`);
  return renderDailyBriefing(tasks, prs, memoriesByMember);
}

export async function buildMorningBriefing(date: string, planMemories: MemHint[]): Promise<string> {
  const tasks = loadRegistryTasks().filter((t) => t.status !== "cancelled");
  return renderMorningBriefing(tasks, planMemories);
}
