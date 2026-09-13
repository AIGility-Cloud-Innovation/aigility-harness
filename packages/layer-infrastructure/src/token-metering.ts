/**
 * L1 底座基础层: Token 用量计量 (token-metering)
 *
 * 按用户/会话/模型聚合 LLM token 消耗, 供管理中心「用量」面板与配额控制取数。
 * - 工厂 createMemoryUsageLedger(): 内存环形缓冲 (默认保留 5000 条), 供装配方直接 import
 * - 插件 @infrastructure/token-metering: record / summary / query 三动作, 供 Provider 走 ctx.call 上报
 *
 * 归因键: userId (平台账号/角色 user_key) 优先, 缺失退回 sessionId —— 按用户
 * 统计要准确, 调用方应在 LlmInferenceRequest.userId 带上身份。
 * usage.source 区分 measured (上游实测) / estimated (本地估算), 成本核算只信 measured。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 类型与工厂 (直接 import 使用) ────────────────────────────────

/** 单次 LLM 调用的用量记录 */
export interface UsageRecord {
  /** ISO 时间戳 */
  at: string;
  /** 归因主体: 平台账号/角色 user_key; 缺失时为 sessionId */
  userId: string;
  /** 归因方式: user = 调用方显式带身份 (会触发积分扣费); session = 退回会话归因 */
  attribution?: "user" | "session";
  /** 来源会话 */
  sessionId: string;
  /** 全链路追踪 ID */
  traceId?: string;
  /** 上报方 Provider 名 (cognitive-llm-inference-stub / -litellm …) */
  provider: string;
  /** 模型标识 */
  model: string;
  /** measured = 上游返回的实测值; estimated = 本地按字符估算 */
  source: "measured" | "estimated";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummaryParams {
  /** 只看某个用户 */
  userId?: string;
  /** ISO 时间下限 (含) */
  since?: string;
  /** 按用户分组取前 N (默认 20) */
  topUsers?: number;
}

export interface UsageGroup {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary {
  /** 汇总窗口内的记录条数 */
  total: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  measuredCalls: number;
  estimatedCalls: number;
  byUser: UsageGroup[];
  byModel: UsageGroup[];
  byDay: UsageGroup[];
}

export interface MemoryUsageLedger {
  append(entry: Omit<UsageRecord, "at">): UsageRecord;
  query(q?: { userId?: string; limit?: number }): UsageRecord[];
  summary(params?: UsageSummaryParams): UsageSummary;
  size(): number;
}

function emptyGroup(key: string): UsageGroup {
  return { key, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addInto(map: Map<string, UsageGroup>, key: string, r: UsageRecord): void {
  const g = map.get(key) ?? emptyGroup(key);
  g.calls += 1;
  g.promptTokens += r.promptTokens;
  g.completionTokens += r.completionTokens;
  g.totalTokens += r.totalTokens;
  map.set(key, g);
}

export function createMemoryUsageLedger(keep = 5000): MemoryUsageLedger {
  const ring: UsageRecord[] = [];
  return {
    append(entry) {
      const full: UsageRecord = { ...entry, at: new Date().toISOString() };
      ring.push(full);
      if (ring.length > keep) ring.splice(0, ring.length - keep);
      return full;
    },
    query(q = {}) {
      let list = ring;
      if (q.userId) list = list.filter((r) => r.userId === q.userId);
      return list.slice(-(q.limit ?? 100)).reverse(); // 新的在前
    },
    summary(params = {}) {
      const list = ring.filter(
        (r) =>
          (!params.userId || r.userId === params.userId) &&
          (!params.since || r.at >= params.since!),
      );
      const byUser = new Map<string, UsageGroup>();
      const byModel = new Map<string, UsageGroup>();
      const byDay = new Map<string, UsageGroup>();
      const total = emptyGroup("all");
      let measuredCalls = 0;
      let estimatedCalls = 0;
      for (const r of list) {
        addInto(byUser, r.userId, r);
        addInto(byModel, r.model, r);
        addInto(byDay, r.at.slice(0, 10), r);
        total.calls += 1;
        total.promptTokens += r.promptTokens;
        total.completionTokens += r.completionTokens;
        total.totalTokens += r.totalTokens;
        if (r.source === "measured") measuredCalls += 1;
        else estimatedCalls += 1;
      }
      const top = params.topUsers ?? 20;
      const sortDesc = (m: Map<string, UsageGroup>, limit?: number) =>
        [...m.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, limit);
      return {
        total: list.length,
        calls: total.calls,
        promptTokens: total.promptTokens,
        completionTokens: total.completionTokens,
        totalTokens: total.totalTokens,
        measuredCalls,
        estimatedCalls,
        byUser: sortDesc(byUser, top),
        byModel: sortDesc(byModel),
        byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
      };
    },
    size() {
      return ring.length;
    },
  };
}

// ── 服务定义 (插件形态, ctx.call 使用) ───────────────────────────

export interface TokenMeteringRequest {
  action: "record" | "summary" | "query";
  /** record: 用量条目 (不含 at) */
  record?: Omit<UsageRecord, "at">;
  /** summary: 汇总参数 */
  params?: UsageSummaryParams;
  /** query: 查询参数 */
  query?: { userId?: string; limit?: number };
}

export interface TokenMeteringResponse {
  /** record 返回写入的条目 */
  entry?: UsageRecord;
  /** summary 返回聚合结果 */
  summary?: UsageSummary;
  /** query 返回明细 (新的在前) */
  entries?: UsageRecord[];
  total: number;
}

export const tokenMeteringService: ServiceDefinition<TokenMeteringRequest, TokenMeteringResponse> = {
  id: "@infrastructure/token-metering",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "Token 用量计量：按用户/会话/模型聚合 LLM token 消耗 (record/summary/query)",
};

/** 进程内共享账本: Provider 上报与装配方 (appbase 管理面板) 直接 import 同一实例 */
export const sharedUsageLedger = createMemoryUsageLedger();

const tokenMeteringProvider: Provider<TokenMeteringRequest, TokenMeteringResponse> = {
  service: tokenMeteringService,
  name: "infrastructure-token-metering-memory",
  state: PluginState.Active,
  async execute(
    request: TokenMeteringRequest,
    ctx: SeamContext,
  ): Promise<Result<TokenMeteringResponse>> {
    if (request.action === "record" && request.record) {
      const entry = sharedUsageLedger.append(request.record);
      // 计费转发: 仅显式带用户身份 (attribution="user") 的用量触发积分扣减;
      // 按会话归因的只计量不计费。计量失败/缺失不影响扣费上游, 反之亦然。
      if (request.record.attribution === "user" && request.record.totalTokens > 0) {
        const r = request.record;
        void ctx
          .call(
            { id: "@infrastructure/credit", versionRange: "^1.0.0" },
            {
              action: "consume",
              userId: r.userId,
              model: r.model,
              promptTokens: r.promptTokens,
              completionTokens: r.completionTokens,
              source: r.source,
              provider: r.provider,
              sessionId: r.sessionId,
              traceId: r.traceId,
            },
          )
          .catch(() => {});
      }
      return ok({ entry, total: sharedUsageLedger.size() });
    }
    if (request.action === "summary") {
      return ok({ summary: sharedUsageLedger.summary(request.params), total: sharedUsageLedger.size() });
    }
    const entries = sharedUsageLedger.query(request.query);
    return ok({ entries, total: sharedUsageLedger.size() });
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: `usage ring holds ${sharedUsageLedger.size()} records`, checkedAt: new Date().toISOString() };
  },
};

export { tokenMeteringProvider };

// ── 插件 Manifest 片段 (并入 @infrastructure 主插件) ─────────────

export const tokenMeteringManifest: PluginManifest = {
  name: "@infrastructure/token-metering",
  layer: LayerId.Infrastructure,
  description: "底座基础层：Token 用量计量（内存环形账本）",
  version: "0.1.0",
  provides: [tokenMeteringService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
