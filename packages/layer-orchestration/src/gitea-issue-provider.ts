/**
 * L4 编排层: gitea-issue-provider — 双向 provider 的收集半边
 * （Gitea 工单 → 登记表候选；实施半边=真人认领/PR/自动关单，后续接线）
 *
 * 补齐"工单先行"缺口：直接在 Gitea 建的工单过去不会回建飞书任务
 * （实测 18 open 只有 2 个有飞书镜像），本 provider 让工单以
 * origin= "gitea-issue" 进登记表，成为与飞书任务平权的收集源。
 *
 * 契约约定：
 *   - guid 采用 "{repo}#{n}"（与 feishu 双建标题、agentd sourceMessageId
 *     "issue:{repo}#{n}" 同一语义空间，去掉 "issue:" 前缀）。
 *   - 只收集 open 工单（closed → done 由终态回写流转，不靠收集）。
 *   - gitea 调用经 call 注入（生产= ctx.call(gitea seam)，测试=假桩），
 *     path 约定与 task-issue-sync 的 issuesBaseFor 一致：
 *     /repos/{org}/{repo}/issues。
 */
import type { CollectTaskInput, TaskCursor, TaskProvider, UnifiedStatus } from "@aigility-harness/core";

export const GITEA_ISSUE_PROVIDER_ID = "gitea-issue";

/** Gitea 原生 state → 统一状态 */
export const GITEA_STATE_TO_STATUS: Record<string, UnifiedStatus> = {
  open: "planned",
  closed: "done",
};

/** gitea-api 透传结果的最小形状（HTTP 语义：value.status） */
export interface GiteaApiResultLike {
  ok: boolean;
  value?: { status?: number; data?: unknown };
  error?: string;
}

/** 注入的 gitea 调用（生产：ctx.call(gitea seam)；测试：假桩） */
export type GiteaCall = (req: Record<string, unknown>) => Promise<GiteaApiResultLike>;

export interface GiteaCollectOptions {
  /** 要扫描的仓库（org/repo full_name），来源 project-registry 的 gitea_repos */
  repos: string[];
  /** 每仓库每页条数（默认 50） */
  pageSize?: number;
}

interface GiteaIssueItem {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  pull_request?: unknown;
}

/** 工单 guid 约定：org/repo#N */
export function issueGuid(repo: string, number: number): string {
  return `${repo}#${number}`;
}

async function listOpenIssues(call: GiteaCall, repo: string, pageSize: number): Promise<GiteaIssueItem[]> {
  const out: GiteaIssueItem[] = [];
  let page = 1;
  for (;;) {
    const r = await call({
      method: "GET",
      // path 必须带 /api/v1 前缀（provider 不自动补；漏了 404——2026-10-15 修）
      path: `/api/v1/repos/${repo}/issues`,
      query: { state: "open", type: "issues", limit: pageSize, page },
    });
    if (!r.ok) return out; // 单仓库失败不拖垮整体扫描，由 stats.errors 记录
    const items = (r.value?.data as GiteaIssueItem[] | undefined) ?? [];
    out.push(...items);
    if (items.length < pageSize) return out;
    page += 1;
  }
}

export async function* sweepGiteaIssues(
  call: GiteaCall,
  opts: GiteaCollectOptions,
  cursor?: TaskCursor,
): AsyncGenerator<CollectTaskInput> {
  const pageSize = opts.pageSize ?? 50;
  const repos = cursor?.value ? opts.repos.slice(opts.repos.indexOf(cursor.value) + 1) : opts.repos;
  for (const repo of repos) {
    const issues = await listOpenIssues(call, repo, pageSize);
    for (const issue of issues) {
      // PR 在 Gitea API 里也走 issues 端点，type=issues 已滤大头，双保险再滤一次
      if (issue.pull_request || !issue.number) continue;
      yield {
        title: issue.title?.trim() || `#${issue.number}`,
        status: GITEA_STATE_TO_STATUS[issue.state ?? "open"] ?? "planned",
        origin: {
          provider: GITEA_ISSUE_PROVIDER_ID,
          guid: issueGuid(repo, issue.number),
          ...(issue.html_url ? { url: issue.html_url } : {}),
        },
        projectRef: repo,
      };
    }
  }
}

export async function collectGiteaIssues(
  call: GiteaCall,
  opts: GiteaCollectOptions,
  cursor?: TaskCursor,
): Promise<CollectTaskInput[]> {
  const out: CollectTaskInput[] = [];
  for await (const c of sweepGiteaIssues(call, opts, cursor)) out.push(c);
  return out;
}

/** 契约实现（收集半边；execute/sync 随实施接线补齐） */
export function createGiteaIssueProvider(call: GiteaCall, opts: GiteaCollectOptions): TaskProvider {
  return {
    id: GITEA_ISSUE_PROVIDER_ID,
    capabilities: { collect: true, execute: false },
    mapStatus: (native: string) => GITEA_STATE_TO_STATUS[native],
    collect: (cursor?: TaskCursor) => sweepGiteaIssues(call, opts, cursor),
  };
}
