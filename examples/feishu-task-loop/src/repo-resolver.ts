/**
 * resolveProjectRefAsync — 归属 token 两级解析（2026-10-10 负责人拍板「改成自动从
 * gitea 检索对应的仓库项目」）：
 *
 *   ① 登记表（config/project-registry.json）— 原 resolveProjectRef 同步逻辑；
 *   ② Gitea 检索回落 — /api/v1/repos/search（q=<token>），仓库名归一化（-/_ 剥平）
 *      匹配：唯一命中采纳，0/多命中不猜（返回候选）。结果缓存 10 分钟，
 *      查询失败静默降级为「未命中」，不阻塞主流程。
 *
 * 背景：登记表仅 3 个项目，「career」这类未登记新仓库全走 ②。
 */
import type { SeamContext } from "@aigility-harness/core";

export type ResolveResult = { repo?: string; candidates: string[] };

const GITEA_API_REF = { id: "@action/gitea-api", versionRange: "^1.0.0" };

/** repo 检索缓存（token → full_name 命中列表），10 分钟 TTL，进程内存即可 */
const searchCache = new Map<string, { at: number; names: string[] }>();
const CACHE_TTL_MS = 10 * 60_000;

type GiteaCallLike = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { status?: number; data?: unknown };
  error?: string;
}>;

function normalizeRepo(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

/** Gitea /repos/search 原始命中（q 检索 + 归一化包含双保险，最近更新优先） */
async function searchRepos(giteaCall: GiteaCallLike, token: string): Promise<string[]> {
  const key = token.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.names;

  const tn = normalizeRepo(key);
  const names = new Set<string>();
  // q= 关键词检索（Gitea 服务端匹配 org/repo 名）
  const r = await giteaCall({
    method: "GET",
    path: "/repos/search",
    query: { q: key, limit: 20, sort: "updated", order: "desc" },
  });
  const payload = r.ok ? r.value?.data : undefined;
  // gitea-api provider 把 {ok, data:[...]} 整体作为 data 返回，剥一层
  const boxed = payload as { ok?: boolean; data?: Array<{ full_name?: string }> } | undefined;
  const items: Array<{ full_name?: string }> = Array.isArray(payload)
    ? (payload as Array<{ full_name?: string }>)
    : (boxed?.data ?? []);
  for (const it of items) {
    const fn = it.full_name ?? "";
    if (!fn) continue;
    const short = fn.split("/").slice(1).join("/") || fn;
    if (normalizeRepo(short).includes(tn)) names.add(fn);
  }
  const list = [...names];
  searchCache.set(key, { at: Date.now(), names: list });
  return list;
}

/**
 * 归属 token 异步解析：登记表 → Gitea 检索回落。
 * 唯一命中给 repo；0/多命中给 candidates（调用方走反问）。
 */
export async function resolveProjectRefAsync(
  token: string,
  giteaCall: GiteaCallLike,
  fallbackSync: (t: string) => { repo?: string; candidates: string[] },
): Promise<ResolveResult> {
  const syncHit = fallbackSync(token);
  if (syncHit.repo) return syncHit;
  try {
    const hits = await searchRepos(giteaCall, token);
    if (hits.length === 1) return { repo: hits[0], candidates: hits };
    if (hits.length > 1) return { candidates: hits };
  } catch {
    // 检索失败静默降级：按登记表结果返回（未命中走反问）
  }
  return syncHit;
}
