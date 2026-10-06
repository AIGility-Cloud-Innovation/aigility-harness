/**
 * L4 编排层: task-collector — 收集侧主干道（providers → TaskRegistry）
 *
 * 「收集侧完全体」的拼装点：对每个带 collect 能力的 provider 增量拉取
 * CollectTaskInput，逐条 registry.adopt（发号/去重/related 关联在表内完成），
 * 返回按 provider 的统计。单个 provider 抛错只记入该 provider 的
 * stats.errors，不拖垮其它源——三源（飞书/工单/agentd）任何一路挂了，
 * 其余两路照常收集。
 *
 * Phase 4 的 TaskRouter 将在此循环后接 ready 判定与派发；本文件只管收集。
 */
import type { CollectTaskInput, TaskCursor, TaskProvider, UnifiedStatus } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";

export interface CollectStats {
  provider: string;
  /** 本轮扫到的候选数 */
  scanned: number;
  /** 新发号收编数 */
  adopted: number;
  /** 命中既有记录（去重）数 */
  existing: number;
  /** 无 guid 等不可收编数 */
  skipped: number;
  errors: string[];
}

export interface CollectRunStats {
  /** uid → 本轮各 provider 是否已见（供调用方做后续闸门） */
  byProvider: Record<string, CollectStats>;
  adoptedTotal: number;
  existingTotal: number;
}

export interface CollectorRunOptions {
  /** 按 provider ID 传游标（断点续传） */
  cursors?: Record<string, TaskCursor>;
}

export async function collectIntoRegistry(
  registry: TaskRegistry,
  providers: TaskProvider[],
  opts: CollectorRunOptions = {},
): Promise<CollectRunStats> {
  const run: CollectRunStats = { byProvider: {}, adoptedTotal: 0, existingTotal: 0 };

  for (const provider of providers) {
    const stats: CollectStats = { provider: provider.id, scanned: 0, adopted: 0, existing: 0, skipped: 0, errors: [] };
    run.byProvider[provider.id] = stats;
    if (!provider.capabilities.collect || !provider.collect) continue;

    try {
      for await (const candidate of provider.collect(opts.cursors?.[provider.id])) {
        if (!candidate.origin?.guid) {
          stats.skipped += 1;
          continue;
        }
        stats.scanned += 1;
        // 既有判定与 registry.adopt 的收敛语义对齐：origin 或任一 related 命中
        // 都算"已入册"（本源句柄会并进既有记录），只有全新任务才算 adopted。
        const known =
          registry.findByExternal(candidate.origin.provider, candidate.origin.guid) ??
          Object.entries(candidate.related ?? {})
            .map(([p, h]) => registry.findByExternal(p, h.guid))
            .find((r): r is NonNullable<typeof r> => Boolean(r));
        registry.adopt(candidate as CollectTaskInput);
        if (known) {
          stats.existing += 1;
          run.existingTotal += 1;
        } else {
          stats.adopted += 1;
          run.adoptedTotal += 1;
        }
      }
    } catch (e) {
      stats.errors.push(String((e as Error)?.message ?? e));
    }
  }
  return run;
}

/** 便捷断言：登记表里属于某 provider 的任务数（测试/看板用） */
export function countByStatus(registry: TaskRegistry, status: UnifiedStatus): number {
  return registry.list({ status: [status] }).length;
}

// 保留 CollectTaskInput 引用（类型面导出，避免调用方重复 import）
export type { CollectTaskInput };
