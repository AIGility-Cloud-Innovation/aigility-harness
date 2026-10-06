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

function loadRegistryTasks(): RegTask[] {
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
