/**
 * L4 编排层: task-reconciler — 定期对齐器（多 provider 冲突/重复的周期巡检）
 *
 * 回答"定期监测同步机制"：collectIntoRegistry 只是一次循环，本文件在其上叠加
 * 周期调度与三类对齐，默认 10 分钟一拍（与 dispatch-scan/TASK_STATE_SCAN 同节奏）：
 *
 *   ① collect   全量收集进登记表（复用 collectIntoRegistry，单源故障隔离）；
 *   ② 重复收敛  飞书标题内嵌 [org/repo#N] 的记录 ↔ 已有工单句柄的记录，
 *               属同一真实任务 → 确定性自动合并（标题即外键，无猜测）；
 *   ③ 冲突巡检  links 句柄 ↔ 反查索引不一致（越权写入/脏数据）+ 执行侧
 *               独占异常（激活态无独占声明 / 独占 provider 缺本源句柄）。
 *
 * 收集侧全任务对齐（多源收敛一条记录），执行侧单 provider 独占
 * （TaskRecord.assigned，claim() 原子领取）——对齐器只检不改执行归属。
 */
import { collectIntoRegistry } from "./task-collector.js";
import type { CollectRunStats } from "./task-collector.js";
import type { TaskProvider } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";

/** 默认对齐节拍：10 分钟（与 task-pipeline/dispatch-scan 同节奏） */
export const DEFAULT_ALIGN_INTERVAL_MS = 600_000;

/** 标题内嵌双建标记 → 工单 guid（org/repo#N）；与 issueNumberFromTaskSummary 同词汇 */
export function issueGuidFromTitle(title: string | undefined): string | undefined {
  const m = title?.match(/\[([^\]#/]+)\/([^\]#]+)#(\d+)\]/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : undefined;
}

export interface AlignReport {
  collected: CollectRunStats;
  /** 本轮自动合并的重复记录 */
  merged: Array<{ keep: string; absorbed: string; via: "issue-title" }>;
  /** 不变量冲突（links ↔ 索引不一致），只报不自动修 */
  conflicts: Array<{ kind: "divergence" | "missing"; uid: string; provider: string; guid: string; indexedTo?: string }>;
  /** 执行独占异常，只报不自动修 */
  exclusivity: Array<{ uid: string; issue: string }>;
}

export async function alignOnce(registry: TaskRegistry, providers: TaskProvider[]): Promise<AlignReport> {
  const collected = await collectIntoRegistry(registry, providers);

  // ② 标题即外键的重复收敛：工单句柄 → 持有者；飞书记录标题解析出同一工单 → 并入
  const merged: AlignReport["merged"] = [];
  const ownerOfIssue = new Map<string, string>();
  for (const r of registry.list()) {
    const viaLink = r.links["gitea-issue"]?.guid;
    const viaOrigin = r.origin.provider === "gitea-issue" ? r.origin.guid : undefined;
    const guid = viaLink ?? viaOrigin;
    if (guid) ownerOfIssue.set(guid, r.uid);
  }
  for (const r of registry.list()) {
    if (r.links["gitea-issue"] || r.origin.provider === "gitea-issue") continue;
    const guid = issueGuidFromTitle(r.title);
    if (!guid) continue;
    const keepUid = ownerOfIssue.get(guid);
    if (!keepUid || keepUid === r.uid) continue;
    const res = registry.merge(keepUid, r.uid);
    // merge 已把被并记录的全部句柄（含飞书句柄）迁入 keep，无需额外补链
    if (res.ok) merged.push({ keep: keepUid, absorbed: r.uid, via: "issue-title" });
  }

  // ③ 冲突与执行独占巡检
  const conflicts = registry.invariantViolations();
  const exclusivity: AlignReport["exclusivity"] = [];
  for (const r of registry.list()) {
    if (r.status === "dispatched" || r.status === "running") {
      if (!r.assigned) {
        exclusivity.push({ uid: r.uid, issue: `激活态（${r.status}）但无独占声明（历史数据或越权写入）` });
      } else if (!(r.assigned.provider in r.links)) {
        exclusivity.push({ uid: r.uid, issue: `独占 ${r.assigned.provider} 但 links 缺该 provider 句柄` });
      }
    }
  }

  return { collected, merged, conflicts, exclusivity };
}

export interface PeriodicAligner {
  /** 立即执行一轮对齐 */
  runOnce(): Promise<AlignReport>;
  /** 启动周期调度（intervalMs 默认 10min，定时器不阻止进程退出） */
  start(): void;
  stop(): void;
  /** 是否在跑 */
  running(): boolean;
}

export function createPeriodicAligner(opts: {
  registry: TaskRegistry;
  providers: TaskProvider[];
  intervalMs?: number;
  onReport?: (report: AlignReport) => void;
  onError?: (e: Error) => void;
  runAtStart?: boolean;
}): PeriodicAligner {
  const { registry, providers, onReport, onError } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_ALIGN_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = () => alignOnce(registry, providers);

  return {
    runOnce,
    start() {
      if (timer) return;
      if (opts.runAtStart) {
        runOnce().then((r) => onReport?.(r)).catch((e) => onError?.(e as Error));
      }
      timer = setInterval(() => {
        runOnce().then((r) => onReport?.(r)).catch((e) => onError?.(e as Error));
      }, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    running: () => timer !== null,
  };
}
