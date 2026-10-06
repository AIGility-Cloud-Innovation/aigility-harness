/**
 * TeamMemoryService — 团队记忆查询服务 (基于 @timem/dsh-plugin-timem 的 TimemClient)
 *
 * 核心链路:
 *   成员名/别名 ──registry──▶ user_id 列表 ──TimemClient──▶ 太忆云记忆
 *   记忆结果 ──registry──◀ 反向标注归属成员
 *
 * 用法 (独立):   const svc = new TeamMemoryService({ apiKey, baseUrl, registryPath })
 * 用法 (cordis): await ctx.plugin(teamMemoryPlugin, { apiKey, registryPath })
 *                await ctx.teamMemory.query("张三", "部署问题")
 */

import { Context } from "@deepseek-ai/cordis";
import { TimemClient } from "@timem/dsh-plugin-timem";
import type { MemoryItem } from "@timem/dsh-plugin-timem";
import { TeamRegistry, type TeamMember } from "./registry.js";

export interface TeamMemoryConfig {
  /** TiMEM Engine API Key (必填) */
  apiKey: string;
  /** API 基础 URL, 默认 https://api.timem.cloud */
  baseUrl?: string;
  /** 登记表路径 (默认 <repo>/config/timem-team-registry.json) */
  registryPath: string;
  /** 未指定成员时的默认记忆域名 (可选) */
  defaultDomain?: string;
}

/** 带归属标注的一条团队记忆 */
export interface AttributedMemory extends MemoryItem {
  /** 归属成员 (registry 反查); null = 未登记 user_id */
  member: { member_id: string; name: string } | null;
  /** 该条记忆实际命中的 user_id */
  resolved_user_id?: string;
}

export interface MemberQueryResult {
  /** 解析到的成员; all 模式为 null */
  member: TeamMember | null;
  /** 查询时实际使用的 user_id 列表 */
  user_ids: string[];
  memories: AttributedMemory[];
  /** 解析失败时的提示 (ambiguous / none) */
  resolveHint?: string;
  errors: string[];
}

/** probe 结果: 某 user_id 在云端是否存活、抽样主题、当前登记归属 */
export interface ProbeResult {
  user_id: string;
  live: boolean;
  sample_count: number;
  sample_topics: string[];
  /** 该 id 当前登记给谁; 未登记为 null */
  bound_to: { member_id: string; name: string } | null;
  error?: string;
}

export class TeamMemoryService {
  readonly registry: TeamRegistry;
  private readonly client: TimemClient;
  private readonly defaultDomain?: string;

  constructor(config: TeamMemoryConfig) {
    this.client = new TimemClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.registry = new TeamRegistry(config.registryPath);
    this.defaultDomain = config.defaultDomain;
  }

  // ── 查询 ─────────────────────────────────────────────────────

  /**
   * 按成员查记忆。memberRef 支持: 姓名 / 别名 / member_id / user_id / "all"(全员)。
   * 多账号成员: 逐 user_id 搜索后合并 (按 score 排序)。
   * pages > 1 时对同一查询翻页取回更多候选 (语义搜索按相关度排序, 翻页扩大日期过滤前的池子)。
   */
  async query(memberRef: string, text: string, limit = 8, pages = 1): Promise<MemberQueryResult> {
    const errors: string[] = [];
    let member: TeamMember | null = null;
    let user_ids: string[];

    if (memberRef === "all") {
      user_ids = this.registry.allUserIds();
      if (!user_ids.length) errors.push("登记表中没有任何已绑定的 user_id");
    } else {
      // 直接给 user_id 也接受 (便于对未知 id 做人工核对)
      if (this.registry.isKnownUserId(memberRef)) {
        user_ids = [String(memberRef)];
        member = this.registry.findByUserId(memberRef) ?? null;
      } else {
        const r = this.registry.resolve(memberRef);
        if (r.kind === "ambiguous") {
          return {
            member: null,
            user_ids: [],
            memories: [],
            resolveHint: `「${memberRef}」匹配到多人: ${r.candidates.map((c) => c.name).join("、")}, 请更具体`,
            errors,
          };
        }
        if (r.kind === "none") {
          // 兜底: 允许直接按未登记 user_id 查询 (人工核对身份用), 结果标注 ⚠未登记
          if (/^[\w.-]{4,64}$/.test(memberRef)) {
            user_ids = [memberRef];
          } else {
            return { member: null, user_ids: [], memories: [], resolveHint: `未找到成员「${memberRef}」, 用 cli list 查看花名册`, errors };
          }
        } else {
          member = r.member;
          user_ids = member.timem_user_ids;
          if (!user_ids.length) {
            return { member, user_ids: [], memories: [], resolveHint: `${member.name} 尚未绑定任何 user_id, 用 cli bind 补录`, errors };
          }
        }
      }
    }

    const merged: AttributedMemory[] = [];
    for (const uid of user_ids) {
      const seenIds = new Set<string>();
      for (let page = 1; page <= Math.max(1, pages); page++) {
        try {
          // 检索限定 L2 提炼层：过滤 L1 原始层（个人快照等碎片噪音，2026-10-05）
          const res = await this.client.searchMemory({ user_id: uid, query: text, limit, domain: this.defaultDomain, page, level: 2 });
          const items = res.memories ?? res.results ?? res.items ?? [];
          for (const it of items) {
            const attributed = this.attribute(it, uid);
            const id = String(attributed.memory_id ?? "");
            if (id && seenIds.has(id)) continue;
            if (id) seenIds.add(id);
            merged.push(attributed);
          }
          if (items.length === 0) break;
        } catch (e) {
          errors.push(`user_id ${uid} 搜索失败: ${(e as Error).message}`);
          break;
        }
      }
    }
    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { member, user_ids, memories: merged.slice(0, limit), errors };
  }

  /** 反向标注: 记忆条目 → 归属成员; 未登记 user_id 记入 unknown 观察清单 */
  attribute(item: MemoryItem, usedUserId?: string): AttributedMemory {
    // 云端协议: 主键字段是 id 而非 memory_id; 时间优先 time_window_start (记忆归属的对话时间)
    const raw = item as MemoryItem & { id?: string; time_window_start?: string };
    const fixed: MemoryItem = {
      ...item,
      memory_id: item.memory_id ?? raw.id ?? "",
      created_at: item.created_at ?? raw.time_window_start ?? "",
    };
    const uid = String(fixed.user_id ?? usedUserId ?? "");
    if (uid) {
      const m = this.registry.findByUserId(uid);
      if (m) return { ...fixed, member: { member_id: m.member_id, name: m.name }, resolved_user_id: uid };
      this.registry.observeUnknown(uid);
    }
    return { ...fixed, member: null, resolved_user_id: uid || undefined };
  }

  // ── 探测 ─────────────────────────────────────────────────────

  /** 验证某 user_id 在太忆云上是否有记忆 (用通用探针词搜索), 用于绑定前确认 */
  async probe(userId: string | number, probeQuery = "工作 项目 问题 计划"): Promise<ProbeResult> {
    const id = String(userId);
    try {
      const res = await this.client.searchMemory({ user_id: id, query: probeQuery, limit: 5 });
      const items = res.memories ?? res.results ?? res.items ?? [];
      const m = this.registry.findByUserId(id);
      return {
        user_id: id,
        live: items.length > 0,
        sample_count: items.length,
        sample_topics: items.map((it) => (it.content ?? "").slice(0, 40)),
        bound_to: m ? { member_id: m.member_id, name: m.name } : null,
      };
    } catch (e) {
      return { user_id: id, live: false, sample_count: 0, sample_topics: [], bound_to: null, error: (e as Error).message };
    }
  }
}

// ── cordis 插件封装 (供 DSH 宿主挂载) ─────────────────────────

declare module "@deepseek-ai/cordis" {
  interface Context {
    teamMemory: TeamMemoryService;
  }
}

export function teamMemoryPlugin(ctx: Context, config: TeamMemoryConfig) {
  ctx.teamMemory = new TeamMemoryService(config);
  return () => {
    delete (ctx as { teamMemory?: TeamMemoryService }).teamMemory;
  };
}
