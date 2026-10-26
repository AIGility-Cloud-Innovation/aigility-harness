/**
 * L4 编排层: pr-finisher — agent 任务的宿主侧 PR 收尾器（执行/交付分离）
 *
 * 背景（2026-10-13）：工人 CLI（codex 等）运行在 codex 沙箱里（--unshare-net、
 * .git 只读挂载），写码/跑测试可以，git commit/push/建 PR 必失败——任务② 实测
 * 踩响。行业标准形态（Copilot coding agent / Devin / Jules 同构）：沙箱只产出
 * 工作区改动，交付由平台层用宿主凭据完成。本模块 = 平台层：
 *
 *   finish({ task, cwd, member, summary, preExisting }):
 *     1. 改动归集：当前 git status − 派发前快照（preExisting）= 本任务新改动
 *        （防同工作区多任务改动混流：任务② 遗留改动不会被卷进任务① 的 PR）
 *     2. fetch + 从 origin/<base> 干净切分支（一任务一分支，业界惯例）
 *     3. 按文件提交（gpg 签名失败退 --no-gpg-sign）
 *     4. push -u origin
 *     5. Gitea API 建 PR（@action/gitea-api 透传）
 *     6. 回写台账（done + PR 链接）+ 通知（notify 注入，缺省仅日志）
 *
 * 失败语义：任一步失败 → 返回 {ok:false}（worker-team 据此记 failed），
 * 改动保留在工作区/stash 不丢，等人接管；不重试不换人（业界惯例：
 * 超时/失败=终态留现场，换人重跑烧 token 且产出混杂——2026-10-13 拍板）。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { SeamContext, TaskRecord } from "@aigility-harness/core";
import type { WorkerTeamOptions } from "./worker-team.js";

const run = promisify(execFile);

/**
 * 统一 git 调用（2026-10-14 中文路径修复）：一律带 `-c core.quotePath=false`。
 *
 * 背景：git 默认 `core.quotePath=true`，`status --porcelain` 把非 ASCII 路径输出成
 * 八进制转义（`.ai/_plan/\346\212\200...md`）并带双引号；该字符串回传给
 * `git add --` 时被当字面路径 → `致命错误：路径规格 '".ai/_plan/\346\212\200'`，
 * agent 任务交付在最后一步 add 全数失败（2026-10-14 「撰写子社区方案说明」实测）。
 * 关掉转义后 status/add/commit 看到的都是原始 UTF-8 路径，链路口径一致。
 */
const git = (args: string[], opts: { cwd: string }) =>
  run("git", ["-c", "core.quotePath=false", ...args], opts);

/** gitea-api 透传结果的最小形状与调用类型（与 gitea-issue-provider 共用定义） */
import type { GiteaApiResultLike, GiteaCall } from "./gitea-issue-provider.js";
import { deliverPingcodeFixed } from "./pingcode-sync.js";
import { looksLikeGatewayError } from "./worker-output-guard.js";

/** 仓库名归一化：剥 owner、忽略大小写与 -/_。 */
function normalizeRepoName(repo: string): string {
  return (repo.split("/").pop() ?? repo).trim().toLowerCase().replace(/[-_]/g, "");
}

/** 从任务标题解析归属仓库 token：优先 [org/repo]，其次【仓库名】；角色词/中文前缀不算归属。 */
const NON_REPO_TOKENS = new Set(["agent", "pi", "codex", "claude", "zcode", "worker", "review", "blocked"]);

export function titleOfRepo(title: string): string | undefined {
  const tokens = [...title.matchAll(/[[【]\s*([^\]】#/\s]+(?:\s*\/\s*[^\]】#/\s]+)?)[\]】]/g)]
    .map((m) => (m[1] ?? "").replace(/\s+/g, ""))
    .filter(Boolean);
  const repoLike = (t: string) => /^[A-Za-z0-9][A-Za-z0-9_\-.\\/]*$/.test(t) && !NON_REPO_TOKENS.has(t.toLowerCase());
  // 组合标题（如【agent】[org/repo]）必须取含 / 的形态——2026-10-26 事故：取首个括号得 agent，同仓交付被误判错仓
  return (
    tokens.find((t) => t.includes("/") && repoLike(t)) ??
    tokens.find((t) => !t.includes("/") && repoLike(t)) ??
    undefined
  );
}

/**
 * 交付前一致性判定：标题归属与 PR 仓库均能解析且短仓库名不一致 → 错仓。
 * 任一侧无法解析时不猜（无归属、外部 URL 等沿用原交付流程）。
 */
export function isWrongRepoDelivery(title: string, prUrl: string): boolean {
  const taskRepo = titleOfRepo(title);
  const prRepo = prUrl.match(/\/([^/]+)\/pulls\/\d+(?:[/?#]|$)/)?.[1];
  return Boolean(taskRepo && prRepo && normalizeRepoName(taskRepo) !== normalizeRepoName(prRepo));
}

// ── 纯函数（单测覆盖） ────────────────────────────────────────────

/** 标题 → 分支 slug：剥【】/[org/repo] 前缀，仅留 ASCII 词字符，空则 task */
export function slugifyBranch(title: string): string {
  const stripped = title
    .replace(/【[^】]*】/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase();
  const slug = stripped
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

/** 展示/标题用：剥【组标】与 [org/repo] 前缀 */
export function cleanTitle(title: string): string {
  return title
    .replace(/^【[^】]*】\s*/, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim();
}

/**
 * git status --porcelain 输出 → 文件路径列表（含 untracked 与删除）
 *
 * 双保险（2026-10-14）：调用侧统一带 `-c core.quotePath=false`（见 git() 封装），
 * 此处再兜底解掉 C 风格引号与八进制转义，防止任何遗漏的调用点把畸形路径
 * 传给 git add 导致交付失败。
 */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // 格式：XY <path>（rename 为 "R  old -> new"，取 new）
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    const raw = arrow >= 0 ? body.slice(arrow + 4) : body;
    paths.push(decodeGitPath(raw));
  }
  return paths;
}

/**
 * 还原 git 的 C 风格引用路径：去首尾双引号 + 八进制转义还原为字节。
 * `"a/\346\212\200.md"` → `a/技.md`。非引用路径原样返回。
 */
export function decodeGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && i + 3 < inner.length + 1) {
      const oct = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
      // 常见 C 转义（\" \\ \n \t）
      const map: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t" };
      if (c === "\\" && map[inner[i + 1]] !== undefined) {
        bytes.push(...Buffer.from(map[inner[i + 1]], "utf8"));
        i++;
        continue;
      }
    }
    bytes.push(...Buffer.from(c, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 本任务改动 = 当前改动 − 派发前快照（按路径差集，保序去重） */
export function diffPaths(now: string[], pre: string[]): string[] {
  const preSet = new Set(pre);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of now) {
    if (preSet.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 按内容判定「本轮有实际改动」的文件（2026-10-25 事故修复）。
 *
 * 事故：`diffPaths` 只比对**路径名**——派发前工作区已有 5 个文件被改过（上一轮残留），
 * 工人本轮又在同一批文件里写了 +181/-10（含新增 159 行测试），收尾仍判「工作区无新改动」
 * → 整轮劳动成果判失败（后端导出卡 t102268 连续两次）。路径相同 ≠ 内容没变。
 *
 * 做法：对每个候选路径算 `git hash-object`（工作区内容哈希），与派发前快照比对；
 * 快照缺失（旧任务无 baseline）时退回旧路径语义，行为不变。
 *
 * @param nowHashes 当前各路径的内容哈希
 * @param preHashes 派发前各路径的内容哈希（undefined = 无快照，退回路径比较）
 * @param prePaths  派发前路径清单（快照缺失时兜底）
 */
export function diffByContent(
  nowHashes: Record<string, string>,
  preHashes: Record<string, string> | undefined,
  prePaths: string[],
): string[] {
  if (!preHashes) return diffPaths(Object.keys(nowHashes), prePaths);
  return Object.keys(nowHashes).filter((p) => {
    const before = preHashes[p];
    // 派发前不存在 → 新增，必收
    if (before === undefined) return true;
    // 存在但内容变了 → 本轮改动，必收（这正是旧实现漏掉的一类）
    return nowHashes[p] !== before;
  });
}

/** 提交信息（单提交口径；多文件一次提交，文件清单进 body） */
export function buildCommitMessage(task: TaskRecord, member: string, files: string[]): string {
  const head = `feat(agent): ${cleanTitle(task.title)}`;
  const body = [
    "",
    `来源: worker-team/${member} 依任务 ${task.uid} 产出（沙箱内编码，宿主收尾交付）`,
    `改动文件 (${files.length}):`,
    ...files.slice(0, 20).map((f) => `  - ${f}`),
    files.length > 20 ? `  ...等 ${files.length} 个文件` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return `${head}\n${body}\n`;
}

/** 工单联动（2026-10-20 拍板：PR 合并即自动关闭来源工单）——标题含 [org/repo#N] 且与任务
 *  归属仓库一致时，PR 正文追加 Gitea 原生关闭关键字（平台在合并时自动关单）。 */
function closeIssueLine(task: TaskRecord): string[] {
  const m = (task.title ?? "").match(/\[([^\]#/]+)\/([^\]#/]+)#(\d+)\]/);
  if (!m) return [];
  if ((task.projectRef ?? "") !== `${m[1]}/${m[2]}`) return []; // 防误关他仓工单
  return [`Closes #${m[3]}`, ""];
}

/** PR 描述 */
export function buildPrBody(task: TaskRecord, member: string, files: string[], summary: string): string {
  const desc = (task.description ?? "").split("\n").slice(0, 12).join("\n");
  return [
    `## agent 任务交付`,
    "",
    `**任务**: ${cleanTitle(task.title)}（${task.uid}）`,
    `**执行**: worker-team/${member}（沙箱内编码，宿主侧 PR 收尾器交付）`,
    "",
    "### 任务描述（节选）",
    "",
    desc,
    "",
    `### 改动文件 (${files.length})`,
    "",
    ...files.slice(0, 20).map((f) => `- \`${f}\``),
    files.length > 20 ? `- …等 ${files.length} 个文件` : "",
    "",
    `### 交付报告（工人最终输出，2026-10-22 起要求结构化：改了什么/没动什么/怎么验证/已知风险）`,
    "",
    summary.slice(0, 4000),
    "",
    ...closeIssueLine(task),
  ].join("\n");
}

// ── git 原语 ─────────────────────────────────────────────────────

/** 当前工作区改动文件（porcelain） */
export async function listChangedFiles(cwd: string): Promise<string[]> {
  // -uall：未跟踪目录展开到文件级。默认模式会把新目录折叠成 `src/`，
  // 而 hash-object 不能对目录求哈希，导致整批候选丢失（含真实代码）。
  const { stdout } = await git(["status", "--porcelain", "--untracked-files=all"], { cwd });
  return parsePorcelain(stdout);
}

/**
 * 工作区改动文件的内容哈希（路径 → blob hash）。
 *
 * 用 `git hash-object --stdin-paths` 一次算完（比逐文件 spawn 快一个量级）；
 * 文件内容为空/被删的项跳过——删除改动由 `listChangedFiles` 的路径差异覆盖。
 */
export async function hashWorkingTree(cwd: string): Promise<Record<string, string>> {
  const files = await listChangedFiles(cwd);
  if (files.length === 0) return {};
  return new Promise<Record<string, string>>((resolve) => {
    const child = spawn("git", ["-c", "core.quotePath=false", "hash-object", "--stdin-paths"], { cwd });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve({}));
    child.on("close", () => {
      const hashes = out.split("\n").map((l) => l.trim()).filter(Boolean);
      // 顺序与输入一致：git 按 stdin 行序输出哈希
      const map: Record<string, string> = {};
      files.forEach((f, i) => {
        if (hashes[i]) map[f] = hashes[i];
      });
      resolve(map);
    });
    child.stdin.end(files.join("\n") + "\n");
  });
}

/**
 * 剔除被 .gitignore 覆盖的路径（2026-10-25 事故修复）。
 *
 * 事故：工人在 worktree 留下 `.backups/<agent>-<时间戳>/` 快照，仓库 .gitignore
 * 已含 `.backups/`。收尾 `git add -- .backups/...` 撞上忽略规则 → git 致命错误
 * "下列路径根据您的一个 .gitignore 文件而被忽略" → 整批交付失败（前端卡 309 行
 * 成果因此送不出去，重试 4 次全废）。
 *
 * 做法：`git check-ignore --no-index --stdin` 一次性判定（比逐文件 spawn 快），
 * 被忽略的剔除。`--no-index` 让已跟踪但后来被 .gitignore 覆盖的文件（历史误提交的
 * .backups/ 等）也能识别——否则 `git add -- <path>` 仍会撞忽略规则而整批失败。
 * 规则完全取自仓库 .gitignore（check-ignore 语义），不在此维护第二套白名单。
 * 命令本身失败时保守返回原列表（宁可交付失败报错，也不静默丢用户改动）。
 */
export async function filterIgnored(files: string[], cwd: string): Promise<string[]> {
  if (files.length === 0) return files;
  return new Promise<string[]>((resolve) => {
    // -z 必须与 --stdin 共用（git 约束）；execFile 不能写 stdin，用 spawn。
    // -z: NUL 分隔，文件名含空格/换行也不会拆错
    const child = spawn("git", ["-c", "core.quotePath=false", "check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve(files)); // git 不可用：保守放行
    child.stdin.on("error", () => {}); // git 提前退出时避免 EPIPE 冒泡
    child.on("close", (code) => {
      // 0=有命中，1=无命中；其余（非 git 仓库/参数错误）保守放行
      if (code !== 0 && code !== 1) {
        resolve(files);
        return;
      }
      // 退出码 1 = 无文件被忽略（正常），stdout 为空 → 全部保留
      const ignored = new Set(out.split("\0").filter(Boolean));
      const kept = files.filter((f) => !ignored.has(f));
      if (ignored.size > 0) {
        console.log(`[pr-finisher] 已跳过 ${ignored.size} 个忽略路径（规则来源：.gitignore）`);
      }
      resolve(kept);
    });
    child.stdin.end(files.join("\0") + "\0");
  });
}

/**
 * 默认基线分支：env 显式 → origin/HEAD → 目标仓库实际 HEAD → 兜底 main。
 *
 * 2026-10-15 事故修正：旧实现 origin/HEAD 探测失败即硬编码回退 "main"，
 * 而服务当时跑在 feat/persona-three-tier（领先 origin/main 48 提交）→ 工人
 * 拿到旧快照、把已有文件当新增提交。现补齐中间两级，使基线与实际运行分支一致。
 * 与 worktree-manager.resolveBaseBranch 同源（保持口径一致）。
 */
/**
 * 交付前基线对齐：特性分支落后 <remote>/<base> 时变基；有冲突则中止变基并拒交（转人工）。
 * 背景：timem_frontend 曾以落后 134 提交的分支直开 PR（mergeable=False），根因即收尾器无对齐步骤。
 */
export async function rebaseAheadIfNeeded(
  cwd: string,
  base: string,
  remote = "origin",
): Promise<{ ok: boolean; detail: string }> {
  const baseRef = `refs/remotes/${remote}/${base}`;
  try {
    const { stdout: mbOut } = await git(["merge-base", "HEAD", baseRef], { cwd });
    const mb = mbOut.trim();
    const { stdout: cntOut } = await git(["rev-list", "--count", `${mb}..${baseRef}`], { cwd });
    const behind = Number.parseInt(cntOut.trim(), 10) || 0;
    if (behind <= 0) return { ok: true, detail: "基线已最新，无需变基" };
    await git(["rebase", baseRef], { cwd });
    return { ok: true, detail: `交付前已向 ${remote}/${base} 变基（曾落后 ${behind} 个提交）` };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const { stdout: names } = await git(["diff", "--name-only", "--diff-filter=U"], { cwd }).catch(() => ({ stdout: "" }));
    const conflicted = names.trim().split("\n").filter(Boolean).slice(0, 5).join("、");
    if (msg.includes("conflict") || conflicted) {
      await git(["rebase", "--abort"], { cwd }).catch(() => {});
      return {
        ok: false,
        detail: `交付前变基失败：分支落后 ${remote}/${base} 且存在冲突（${conflicted || "未知文件"}）。已中止变基保持现场，转人工解决冲突后再交付`,
      };
    }
    return { ok: false, detail: `交付前基线对齐失败：${msg.slice(0, 160)}` };
  }
}

export async function detectBaseBranch(cwd: string): Promise<string> {
  const explicit = (process.env["WORKER_TEAM_BASE_BRANCH"] ?? "").trim();
  if (explicit) return explicit;
  try {
    const { stdout } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
    const m = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    // 未设置 origin/HEAD 时继续下探
  }
  try {
    const { stdout } = await git(["symbolic-ref", "--short", "HEAD"], { cwd });
    const cur = stdout.trim();
    if (cur && cur !== "HEAD") return cur;
  } catch {
    // detached HEAD / 非 git 目录
  }
  return "main";
}

// ── 收尾器 ───────────────────────────────────────────────────────

export interface PrFinisherOptions {
  /** SeamContext（@action/gitea-api 调用用）；测试可注入假 giteaCall */
  ctx?: SeamContext;
  /** 测试/独立运行用的直接 gitea 调用（优先于 ctx） */
  giteaCall?: GiteaCall;
  /** PR 基线分支（缺省探测 origin/HEAD，再退 main） */
  baseBranch?: string;
  /** 分支前缀（缺省 agent/） */
  branchPrefix?: string;
  /** 回程通知（缺省仅日志） */
  notify?: (text: string) => Promise<void> | void;
}

export interface FinishInfo {
  task: TaskRecord;
  cwd?: string;
  member: string;
  /** 工人返回的摘要文本 */
  summary: string;
  /** 派发前工作区快照（本任务改动 = 当前 − 快照） */
  preExisting: string[];
  /**
   * 派发前各文件的内容哈希（2026-10-25 修复）。
   * 路径相同但内容变了也算本轮改动；缺省时退回纯路径比较（旧任务兼容）。
   */
  preExistingHashes?: Record<string, string>;
  /**
   * 已在 worktree 中切好的分支名（2026-10-13 worktree 隔离）。
   * 提供时收尾器跳过「checkout -B + stash 兜底」——worktree 本就是干净的
   * 独立检出，无需再切分支（那正是多任务抢主仓库时踩坑的一步）。
   */
  branch?: string;
}

/** 建 PR（gitea-api：POST /repos/{org}/{repo}/pulls） */
async function createPullRequest(
  call: GiteaCall,
  p: { repo: string; head: string; base: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const r = await call({
    method: "POST",
    // path 必须带 /api/v1 前缀（provider 不自动补；漏了会 404「Not found.」→ 误报「无 number」——2026-10-15 修）
    path: `/api/v1/repos/${p.repo}/pulls`,
    body: { title: p.title, head: p.head, base: p.base, body: p.body },
  });
  if (!r.ok) {
    const status = r.value?.status;
    throw new Error(`建 PR 失败${status ? `（HTTP ${status}）` : ""}: ${r.error ?? "未知"}`);
  }
  // gitea-api provider 把上游响应体整体包进 data（即 r.value.data = {ok, data:{number…}}），
  // 兼容直接返回顶层 number 的形状（2026-10-13 PR #145 事故：少剥一层导致误判交付失败）
  const raw = (r.value?.data ?? {}) as Record<string, unknown>;
  const nested = raw.data as { number?: number; html_url?: string } | undefined;
  const d =
    typeof raw.number === "number"
      ? ({ number: raw.number, html_url: raw.html_url } as { number?: number; html_url?: string })
      : nested;
  if (!d?.number) {
    // 「PR 已存在」不是失败（2026-10-25 事故）：工人可能重跑，分支上已有开放 PR，
    // Gitea 返回 409-ish 的 message 而非 number。此时应复用已有 PR，把新提交补进去，
    // 而不是把整轮成果判为失败（前端卡因此白跑一轮）。
    const msgText = JSON.stringify(raw);
    if (/already exists/i.test(msgText)) {
      const existing = await findOpenPr(call, p.repo, p.head);
      if (existing) return existing;
    }
    throw new Error(`建 PR 响应异常: 无 number（data=${msgText.slice(0, 200)}）`);
  }
  return { number: d.number, url: d.html_url ?? `PR #${d.number}` };
}

/** 按 head 分支查已开放的 PR（复用而非重复创建） */
async function findOpenPr(
  call: GiteaCall,
  repo: string,
  head: string,
): Promise<{ number: number; url: string } | undefined> {
  const r = await call({
    method: "GET",
    path: `/api/v1/repos/${repo}/pulls?state=open&limit=50`,
  });
  if (!r.ok) return undefined;
  const raw = (r.value?.data ?? {}) as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (raw.data as unknown[] | undefined) ?? []) as Array<{
    number?: number;
    html_url?: string;
    head?: { ref?: string };
  }>;
  const hit = list.find((x) => x.head?.ref === head);
  return hit?.number ? { number: hit.number, url: hit.html_url ?? `PR #${hit.number}` } : undefined;
}

/**
 * 组装收尾器（worker-team 的 finish 钩子）。任一步失败返回 {ok:false,detail}
 * ——由 worker-team 记 failed 并保留现场；本函数自身不重试。
 */
export function createPrFinisher(opts: PrFinisherOptions): NonNullable<WorkerTeamOptions["finish"]> {
  const call: GiteaCall =
    opts.giteaCall ??
    (async (req) =>
      (await opts.ctx!.call({ id: "@action/gitea-api", versionRange: "^1.0.0" }, req)) as GiteaApiResultLike);

  return async (info: FinishInfo) => {
    const { task, cwd, member, summary, preExisting, preExistingHashes } = info;
    // 防线外层（2026-10-22 事故兜底）：内层 worker-team 已拦一次，这里再拦——
    // 任何路径都不允许 API/网关报错原文进 PR 正文当「交付报告」。
    if (looksLikeGatewayError(summary)) {
      const detail = `工人输出为 API/网关报错原文，拒绝建 PR（防报错当交付）。首 120 字：${summary.slice(0, 120)}`;
      await notifyFail(opts, task, detail, "");
      return { ok: false, detail };
    }
    if (!cwd) {
      await notifyFail(opts, task, "任务无 cwd（projectRef 未解析到本机仓库）", "改动未落盘或仍在沙箱");
      return { ok: false, detail: "任务无 cwd，无法收尾" };
    }
    try {
      // 1. 改动归集：新改动 = 当前 − 派发前快照（防多任务混流）
      // 2026-10-25：升级为按内容哈希判定——派发前已有改动的同一文件，本轮内容变了也算交付。
      const nowHashes = await hashWorkingTree(cwd).catch(() => ({} as Record<string, string>));
      const candidates =
        Object.keys(nowHashes).length > 0
          ? diffByContent(nowHashes, preExistingHashes, preExisting)
          : diffPaths(await listChangedFiles(cwd), preExisting);
      if (candidates.length === 0) {
        const detail = "工作区无新改动（工人未落盘或改动全为派发前已有）";
        await notifyFail(opts, task, detail, "");
        return { ok: false, detail };
      }
      // 交付前剔除 .gitignore 覆盖的文件（2026-10-25 事故）：工人常留 .backups/ 快照，
      // 而仓库 .gitignore 已忽略它 —— git add 撞忽略规则直接致命，整批改动送不出去
      // （前端卡 309 行成果卡在这一步）。在改动归集处就过滤，后续 PR 正文/文件数也不含工件。
      const files = await filterIgnored(candidates, cwd);
      if (files.length === 0) {
        const detail = `改动全部落在 .gitignore 覆盖范围内（跳过 ${candidates.length} 个忽略路径），无可交付文件`;
        await notifyFail(opts, task, detail, "");
        return { ok: false, detail };
      }

      // 2. fetch + 基线分支（fetch 加重试；失败即中止交付，避免拿陈旧 origin/<base> 建 PR）
      let fetched = false;
      for (let attempt = 1; attempt <= 3 && !fetched; attempt++) {
        try {
          await git(["fetch", "origin", "--prune"], { cwd });
          fetched = true;
        } catch {
          if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000 * attempt));
        }
      }
      if (!fetched) {
        const detail = "fetch origin 重试 3 次仍失败，放弃交付（不用陈旧基线建 PR）";
        await notifyFail(opts, task, detail, "");
        return { ok: false, detail };
      }
      // 交付远端可配（2026-10-19 整改③）：双远端仓（origin=GitHub、权威=Gitea）可显式指定交付目标，默认 origin 不变
      const deliveryRemote = (process.env["WORKER_TEAM_DELIVERY_REMOTE"] ?? "origin").trim() || "origin";
      const base = opts.baseBranch ?? (await detectBaseBranch(cwd));
      if (deliveryRemote !== "origin") {
        // 交付远端≠origin 时单独保鲜其 refs/remotes（供变基比对）；失败不在此处致命，后续变基步骤会明确报错
        await git(["fetch", deliveryRemote, "--prune"], { cwd }).catch(() => {});
      }

      // 3. 一任务一分支；worktree 隔离下分支已切好（info.branch），跳过 checkout/stash
      const branch = info.branch
        ?? `${opts.branchPrefix ?? "agent/"}${slugifyBranch(task.title ?? "")}-${task.uid.slice(-6)}`;
      if (!info.branch) {
        try {
          await git(["checkout", "-B", branch, `refs/remotes/origin/${base}`], { cwd });
        } catch {
          await git(["stash", "push", "-u", "-m", `pr-finisher:${task.uid}`], { cwd });
          await git(["checkout", "-B", branch, `refs/remotes/origin/${base}`], { cwd });
          await git(["stash", "pop"], { cwd });
        }
      }

      // 4. 按文件提交（gpg 失败退无签名重试一次）
      await git(["add", "--", ...files], { cwd });
      const msg = buildCommitMessage(task, member, files);
      try {
        await git(["commit", "-m", msg], { cwd });
      } catch {
        await git(["commit", "--no-gpg-sign", "-m", msg], { cwd });
      }

      // 4.5 交付前基线对齐（整改②）：落后即变基，冲突拒交转人工——不带陈旧基线开 PR
      const rb = await rebaseAheadIfNeeded(cwd, base, deliveryRemote);
      if (!rb.ok) {
        await notifyFail(opts, task, rb.detail, "");
        return { ok: false, detail: rb.detail };
      }

      // 5. push（交付远端可配，默认 origin）
      await git(["push", "-u", deliveryRemote, branch], { cwd });

      // 6. 建 PR
      const pr = await createPullRequest(call, {
        repo: task.projectRef ?? "",
        head: branch,
        base,
        title: cleanTitle(task.title ?? task.uid),
        body: buildPrBody(task, member, files, summary),
      });

      // 7. 回程通知 + 台账 detail（worker-team 记 done/note）
      // 错仓保险：在通知与 PingCode 副作用前终判失败，避免错仓 PR 触发下游挪卡/建卡。
      if (isWrongRepoDelivery(task.title ?? "", pr.url)) {
        const expectedRepo = titleOfRepo(task.title ?? "");
        const actualRepo = pr.url.split("/").at(-3) ?? pr.url;
        const detail = `错仓：PR 在 ${actualRepo}，卡归属 ${expectedRepo}（${pr.url}）；不挪 C、不建 PC 修复卡`;
        await notifyFail(opts, task, detail, "改动与 PR 已保留，等待人工迁移或关闭");
        return { ok: false, detail };
      }
      // PingCode 同步（2026-10-23 用户需求）：agent 交付 PR → 建缺陷卡并置「已修复」。
      // 旁路：未配置凭据/任何异常静默跳过，不阻塞交付。
      let pcSuffix = "";
      try {
        const pcIdent = await deliverPingcodeFixed(task, pr.url);
        if (pcIdent) pcSuffix = `\n📌 PingCode 已建「已修复」卡：${pcIdent}`;
      } catch { /* 旁路 */ }
      const text = `✅ agent 任务已交付 PR\n「${cleanTitle(task.title ?? task.uid)}」\n${pr.url}\n分支 ${branch} → ${base}｜改动 ${files.length} 个文件${pcSuffix}`;
      try {
        await opts.notify?.(text);
      } catch (e) {
        console.error(`[pr-finisher] 通知失败: ${String((e as Error)?.message ?? e)}`);
      }
      return { ok: true, detail: `${pr.url}（${branch} → ${base}，${files.length} 文件）${pcSuffix.trim()}` };
    } catch (e) {
      const detail = String((e as Error)?.message ?? e).slice(0, 300);
      await notifyFail(opts, task, detail, `改动保留在 ${cwd} 工作区（或 stash），等待接管`);
      return { ok: false, detail };
    }
  };
}

async function notifyFail(opts: PrFinisherOptions, task: TaskRecord, reason: string, keep: string): Promise<void> {
  try {
    await opts.notify?.(`⚠️ agent 任务交付失败\n「${cleanTitle(task.title ?? task.uid)}」（${task.uid}）\n原因：${reason}${keep ? `\n${keep}` : ""}`);
  } catch (e) {
    console.error(`[pr-finisher] 失败通知出错: ${String((e as Error)?.message ?? e)}`);
  }
}
