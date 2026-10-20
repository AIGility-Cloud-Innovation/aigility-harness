/**
 * L4 编排层: worktree-manager — 每任务一 worktree（多任务隔离）
 *
 * 背景（2026-10-13 事故）：worker-team 此前让工人在「主仓库工作区」直接改码，
 * pr-finisher 收尾时主仓库已有他人改动 → `git checkout -B` 失败 → 退化为
 * `stash push` + `stash pop`，pop 大面积冲突后中断，仓库停在未完成的 stash 态
 * （实测两次：tsk_b9a83adc、tsk_06219670）。
 *
 * 行业惯例（agentd 同构，timem-project/internal/workflow/workflow.go:294）：
 *   git -C <project.Path> worktree add -b <branch> <worktree> <remote>/<ref>
 * 每任务独立 worktree + 独立分支，工人在自己目录里干活，天然互不干扰；
 * 收尾器在该 worktree 内提交/推送/建 PR，无需 stash 兜底。
 *
 * 命名（对齐 agentd 的 <WorktreeRoot>/<projectID>/<taskID> 思路，扁平化一层）：
 *   <WORKER_TEAM_WORKTREE_ROOT 或 ~/.config/TiMEM Project/worktrees>
 *     /<repo 短名>-<task uid 后 6 位>
 *
 * ── 基线正确性（2026-10-15 事故复盘）─────────────────────────────
 * 事故：tsk_b8c08dd7 派下去后 codex 把工作区已有文件当成「新增」提交，
 * 72 文件巨型 diff、目标 bug 一行没修。根因是基线取错：
 *   origin/HEAD 未设置 → detectBaseBranch 兜底硬编码 "main"
 *   而服务实际跑在 feat/persona-three-tier（领先 origin/main 48 提交）
 *   → 工人拿到的是「缺 48 个提交」的旧快照。
 *
 * 三道防线（Q1-A + Q2-B，2026-10-15 用户拍板）：
 *   ① 基线三级探测：env 显式 → origin/HEAD → 目标仓库实际 HEAD → 兜底 main
 *   ② fetch 失败重试 3 次，仍失败则拒绝派发（不用陈旧引用硬跑）
 *   ③ 新鲜度校验：切分支前确认 origin/<base> == 远端实际 SHA，不一致则视为陈旧
 * 原则：宁可拒绝派发 + 播报，也不用不确定的基线干活。
 */
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { slugifyBranch } from "./pr-finisher.js";

const run = promisify(execFile);

/** 基线 fetch 失败时的重试次数（Q2-B：重试 3 次后中止派发） */
const FETCH_RETRY = 3;
/** 重试间隔（毫秒）；指数退避 base */
const FETCH_RETRY_DELAY_MS = 2_000;

/** worktree 根目录：env 优先（沿用 agentd 的目录便于统一治理），默认 ~/AI/.worktrees */
export function worktreeRoot(): string {
  return (
    process.env["WORKER_TEAM_WORKTREE_ROOT"] ??
    join(homedir(), "AI", ".worktrees")
  );
}

/** worktree 目录名：<repo 短名>-<uid 后 6 位>（稳定可复算，便于清理与排查） */
export function worktreeDirName(repoRoot: string, taskUid: string): string {
  const repo = repoRoot.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const short = taskUid.slice(-6).replace(/[^a-zA-Z0-9]/g, "") || "task";
  return `${repo}-${short}`;
}

/** 任务分支名（与 pr-finisher 保持一致前缀与 slug 规则） */
export function worktreeBranch(taskUid: string, title: string, prefix = "agent/"): string {
  return `${prefix}${slugifyBranch(title)}-${taskUid.slice(-6)}`;
}

/** 带退避的 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 基线三级探测（Q1-A，2026-10-15 拍板）。
 *
 * 优先级：
 *   ① `WORKER_TEAM_BASE_BRANCH`（显式配置，最高优先，覆盖一切）
 *   ② `refs/remotes/origin/HEAD`（仓库自己的默认分支声明）
 *   ③ 目标仓库**实际 checkout 的 HEAD 分支**（谁在跑就用谁的基线）
 *   ④ 兜底 `main`（仅当前三者都拿不到）
 *
 * 为什么加 ③：事故当天 origin/HEAD 未设置、服务跑在特性分支上，
 * 旧的写法直接兜底 main —— 与生产代码脱节 48 个提交。③ 让基线跟随
 * 「目标仓库当前所在分支」，与服务实际运行代码保持一致。
 */
export async function resolveBaseBranch(repoRoot: string): Promise<{ base: string; source: string }> {
  // ① 显式配置
  const explicit = (process.env["WORKER_TEAM_BASE_BRANCH"] ?? "").trim();
  if (explicit) return { base: explicit, source: "env:WORKER_TEAM_BASE_BRANCH" };

  // ② origin/HEAD
  try {
    const { stdout } = await run("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], {
      timeout: 10_000,
    });
    const m = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return { base: m[1], source: "origin/HEAD" };
  } catch {
    // 未设置 origin/HEAD，继续下探
  }

  // ③ 目标仓库实际 HEAD 分支
  try {
    const { stdout } = await run("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], {
      timeout: 10_000,
    });
    const cur = stdout.trim();
    // detached HEAD 时 symbolic-ref 会抛错（已被 catch），若返回 HEAD 字样也视为无效
    if (cur && cur !== "HEAD") return { base: cur, source: "repo HEAD (实际所在分支)" };
  } catch {
    // detached HEAD 或非 git 目录，继续下探
  }

  // ④ 兜底：dev（2026-10-19 整改①）——流程=「开发前从 dev 创建特性分支」，探测链全空时 dev 比 main 更贴近交付基线
  return { base: "dev", source: "fallback:dev" };
}

/**
 * fetch origin（带重试 + 新鲜度校验）。
 *
 * 返回：
 *   · ok:true —— fetch 成功且（若可判定）origin/<base> 已是最新
 *   · ok:false —— 重试耗尽仍失败，调用方**必须放弃派发**（不用陈旧引用硬跑）
 *
 * 新鲜度校验说明：`git fetch` 成功后，本地 `refs/remotes/origin/<base>` 即被
 * 更新到远端当前值，故「fetch 成功」本身已保证新鲜；额外用 `ls-remote` 比对
 * 一次，用于捕获「fetch 报成功但引用未更新」这一罕见情形（例如远端被强推）。
 */
async function fetchBaseWithRetry(
  repoRoot: string,
  base: string,
): Promise<{ ok: boolean; error?: string; staleDetail?: string }> {
  let lastErr = "";
  for (let attempt = 1; attempt <= FETCH_RETRY; attempt++) {
    try {
      await run("git", ["-C", repoRoot, "fetch", "origin", "--prune"], { timeout: 120_000 });
      break; // 成功
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e).slice(0, 200);
      if (attempt < FETCH_RETRY) await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
  }
  if (lastErr) {
    return { ok: false, error: `fetch origin 重试 ${FETCH_RETRY} 次仍失败：${lastErr}` };
  }

  // 新鲜度校验：远端实际 SHA vs 本地 origin/<base>
  try {
    const remoteSha = (await run("git", ["-C", repoRoot, "ls-remote", "origin", `refs/heads/${base}`], {
      timeout: 60_000,
    })).stdout.trim().split(/\s+/)[0];
    if (remoteSha) {
      const localSha = (await run("git", ["-C", repoRoot, "rev-parse", `refs/remotes/origin/${base}`], {
        timeout: 10_000,
      })).stdout.trim();
      if (localSha && localSha !== remoteSha) {
        return {
          ok: false,
          error: `基线 origin/${base} 陈旧：本地 ${localSha.slice(0, 8)} ≠ 远端 ${remoteSha.slice(0, 8)}`,
        };
      }
    }
  } catch {
    // ls-remote 失败（网络抖动/分支不存在）不致命：fetch 已成功，按成功处理
  }
  return { ok: true };
}

export interface EnsureWorktreeResult {
  ok: boolean;
  /** worktree 绝对路径（ok 时） */
  path?: string;
  /** 分支名（ok 时） */
  branch?: string;
  /** 实际使用的基线分支（ok 时） */
  base?: string;
  /** 基线探测来源（诊断用） */
  baseSource?: string;
  /** 失败原因 */
  error?: string;
}

/**
 * 确保任务专属 worktree 存在且基于 origin/<base> 切好分支。
 *
 * - 已存在同名 worktree（重试/续跑）：直接复用，不重复 add（git 会报 already exists）
 * - 已存在同名分支但从上一轮残留：worktree add 会自动检出该分支（-b 失败时退 -B 语义）
 * - fetch 失败：重试 3 次（Q2-B）；仍失败**拒绝派发**，绝不退回陈旧引用
 * - base 省略时按 resolveBaseBranch 三级探测（Q1-A）
 *
 * 返回 ok:false 时调用方应放弃派发（不落回主仓库——那正是事故来源）。
 */
export async function ensureWorktree(opts: {
  repoRoot: string;
  taskUid: string;
  title: string;
  /** 省略则三级探测（env → origin/HEAD → 目标仓库实际 HEAD → main） */
  base?: string;
  branchPrefix?: string;
  root?: string;
}): Promise<EnsureWorktreeResult> {
  const { repoRoot, taskUid, title } = opts;
  const root = opts.root ?? worktreeRoot();
  const wtPath = join(root, worktreeDirName(repoRoot, taskUid));
  const branch = worktreeBranch(taskUid, title, opts.branchPrefix);

  try {
    // 复用已存在的 worktree（同任务重试）
    if (existsSync(wtPath)) {
      return { ok: true, path: wtPath, branch };
    }

    mkdirSync(root, { recursive: true, mode: 0o700 });

    // ① 基线探测（显式传入优先，否则三级探测）
    let base = opts.base?.trim();
    let baseSource = base ? "调用方指定" : "";
    if (!base) {
      const r = await resolveBaseBranch(repoRoot);
      base = r.base;
      baseSource = r.source;
    }

    // ② fetch（重试 + 新鲜度校验）；失败即拒绝派发
    const f = await fetchBaseWithRetry(repoRoot, base);
    if (!f.ok) {
      return { ok: false, error: `${f.error}｜基线=${base}(${baseSource})` };
    }

    // ③ 切分支
    const ref = `refs/remotes/origin/${base}`;
    try {
      await run("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, ref], {
        timeout: 60_000,
      });
    } catch (e) {
      // 分支已存在（上轮残留）：改从该分支检出（保留其历史，便于续跑）
      // 注意匹配中文 git 输出（致命错误：…已经存在），否则中文环境回退永不触发（2026-10-20 实测）
      const msg = String((e as Error)?.message ?? e);
      if (/already exists|已经存在/i.test(msg)) {
        await run("git", ["-C", repoRoot, "worktree", "add", wtPath, branch], { timeout: 60_000 });
      } else {
        throw e;
      }
    }
    return { ok: true, path: wtPath, branch, base, baseSource };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}