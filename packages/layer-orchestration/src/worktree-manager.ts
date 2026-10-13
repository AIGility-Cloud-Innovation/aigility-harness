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
 */
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { slugifyBranch } from "./pr-finisher.js";

const run = promisify(execFile);

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

export interface EnsureWorktreeResult {
  ok: boolean;
  /** worktree 绝对路径（ok 时） */
  path?: string;
  /** 分支名（ok 时） */
  branch?: string;
  /** 失败原因 */
  error?: string;
}

/**
 * 确保任务专属 worktree 存在且基于 origin/<base> 切好分支。
 *
 * - 已存在同名 worktree（重试/续跑）：直接复用，不重复 add（git 会报 already exists）
 * - 已存在同名分支但从上一轮残留：worktree add 会自动检出该分支（-b 失败时退 -B 语义）
 * - fetch 失败不致命（离线/网络抖动）：用本地已有的 origin/<base> 继续
 *
 * 返回 ok:false 时调用方应放弃派发（不落回主仓库——那正是事故来源）。
 */
export async function ensureWorktree(opts: {
  repoRoot: string;
  taskUid: string;
  title: string;
  base: string;
  branchPrefix?: string;
  root?: string;
}): Promise<EnsureWorktreeResult> {
  const { repoRoot, taskUid, title, base } = opts;
  const root = opts.root ?? worktreeRoot();
  const wtPath = join(root, worktreeDirName(repoRoot, taskUid));
  const branch = worktreeBranch(taskUid, title, opts.branchPrefix);

  try {
    // 复用已存在的 worktree（同任务重试）
    if (existsSync(wtPath)) {
      return { ok: true, path: wtPath, branch };
    }

    mkdirSync(root, { recursive: true, mode: 0o700 });

    // 尽量拉新（失败不致命：本地可能有可用的 origin/<base>）
    try {
      await run("git", ["-C", repoRoot, "fetch", "origin"], { timeout: 60_000 });
    } catch {
      // ignore：用本地引用继续
    }

    const ref = `refs/remotes/origin/${base}`;
    try {
      // 标准路径：从 origin/<base> 新建分支
      await run("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, ref], {
        timeout: 60_000,
      });
    } catch (e) {
      // 分支已存在（上轮残留）：改从该分支检出（保留其历史，便于续跑）
      const msg = String((e as Error)?.message ?? e);
      if (/already exists/i.test(msg)) {
        await run("git", ["-C", repoRoot, "worktree", "add", wtPath, branch], { timeout: 60_000 });
      } else {
        throw e;
      }
    }
    return { ok: true, path: wtPath, branch };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}