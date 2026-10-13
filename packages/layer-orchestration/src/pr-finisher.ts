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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SeamContext, TaskRecord } from "@aigility-harness/core";
import type { WorkerTeamOptions } from "./worker-team.js";

const run = promisify(execFile);

/** gitea-api 透传结果的最小形状与调用类型（与 gitea-issue-provider 共用定义） */
import type { GiteaApiResultLike, GiteaCall } from "./gitea-issue-provider.js";

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

/** git status --porcelain 输出 → 文件路径列表（含 untracked 与删除） */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // 格式：XY <path>（rename 为 "R  old -> new"，取 new）
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    paths.push(arrow >= 0 ? body.slice(arrow + 4) : body);
  }
  return paths;
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
    "### 工人摘要",
    "",
    summary.slice(0, 600),
    "",
  ].join("\n");
}

// ── git 原语 ─────────────────────────────────────────────────────

/** 当前工作区改动文件（porcelain） */
export async function listChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await run("git", ["status", "--porcelain"], { cwd });
  return parsePorcelain(stdout);
}

/** 默认基线分支：origin/HEAD 探测 → 回退 main */
export async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
    const m = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    // 未设置 origin/HEAD 时回退
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
    path: `/repos/${p.repo}/pulls`,
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
  if (!d?.number) throw new Error(`建 PR 响应异常: 无 number（data=${JSON.stringify(raw).slice(0, 200)}）`);
  return { number: d.number, url: d.html_url ?? `PR #${d.number}` };
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
    const { task, cwd, member, summary, preExisting } = info;
    if (!cwd) {
      await notifyFail(opts, task, "任务无 cwd（projectRef 未解析到本机仓库）", "改动未落盘或仍在沙箱");
      return { ok: false, detail: "任务无 cwd，无法收尾" };
    }
    try {
      // 1. 改动归集：新改动 = 当前 − 派发前快照（防多任务混流）
      const files = diffPaths(await listChangedFiles(cwd), preExisting);
      if (files.length === 0) {
        const detail = "工作区无新改动（工人未落盘或改动全为派发前已有）";
        await notifyFail(opts, task, detail, "");
        return { ok: false, detail };
      }

      // 2. fetch + 基线分支
      await run("git", ["fetch", "origin"], { cwd });
      const base = opts.baseBranch ?? (await detectBaseBranch(cwd));

      // 3. 一任务一分支；worktree 隔离下分支已切好（info.branch），跳过 checkout/stash
      const branch = info.branch
        ?? `${opts.branchPrefix ?? "agent/"}${slugifyBranch(task.title ?? "")}-${task.uid.slice(-6)}`;
      if (!info.branch) {
        try {
          await run("git", ["checkout", "-B", branch, `refs/remotes/origin/${base}`], { cwd });
        } catch {
          await run("git", ["stash", "push", "-u", "-m", `pr-finisher:${task.uid}`], { cwd });
          await run("git", ["checkout", "-B", branch, `refs/remotes/origin/${base}`], { cwd });
          await run("git", ["stash", "pop"], { cwd });
        }
      }

      // 4. 按文件提交（gpg 失败退无签名重试一次）
      await run("git", ["add", "--", ...files], { cwd });
      const msg = buildCommitMessage(task, member, files);
      try {
        await run("git", ["commit", "-m", msg], { cwd });
      } catch {
        await run("git", ["commit", "--no-gpg-sign", "-m", msg], { cwd });
      }

      // 5. push
      await run("git", ["push", "-u", "origin", branch], { cwd });

      // 6. 建 PR
      const pr = await createPullRequest(call, {
        repo: task.projectRef ?? "",
        head: branch,
        base,
        title: cleanTitle(task.title ?? task.uid),
        body: buildPrBody(task, member, files, summary),
      });

      // 7. 回程通知 + 台账 detail（worker-team 记 done/note）
      const text = `✅ agent 任务已交付 PR\n「${cleanTitle(task.title ?? task.uid)}」\n${pr.url}\n分支 ${branch} → ${base}｜改动 ${files.length} 个文件`;
      try {
        await opts.notify?.(text);
      } catch (e) {
        console.error(`[pr-finisher] 通知失败: ${String((e as Error)?.message ?? e)}`);
      }
      return { ok: true, detail: `${pr.url}（${branch} → ${base}，${files.length} 文件）` };
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
