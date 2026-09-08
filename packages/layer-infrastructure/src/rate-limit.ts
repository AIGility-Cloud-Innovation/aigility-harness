/**
 * L1 底座基础层: 内存限流器 (rate-limit)
 *
 * 通用「失败计数 + 锁定」限流能力, 典型用途: 登录暴力破解防护。
 * - 工厂 createMemoryRateLimiter(): 供装配方直接 import (backend 无 kernel ctx 场景, 同 sse.ts 先例)
 * - 插件 @infrastructure/rate-limit: check / fail / reset 三动作, 供其他装配走 ctx.call
 *
 * 状态存进程内存: 重启即清零 —— 限流是可自愈的临时惩罚, 持久化反而会误伤。
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
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 工厂 (直接 import 使用) ──────────────────────────────────────

export interface RateLimiterOptions {
  /** 连续失败多少次后锁定 (默认 5) */
  maxFails?: number;
  /** 锁定时长毫秒 (默认 15 分钟) */
  lockMs?: number;
}

export interface RateLimitState {
  /** 当前是否处于锁定期 */
  locked: boolean;
  /** 锁定剩余分钟 (向上取整, 未锁定为 0) */
  retryAfterMin: number;
  /** 距锁定还剩几次失败机会 (已锁定为 0) */
  remaining: number;
}

export interface MemoryRateLimiter {
  /** 查询 key 是否被锁定 (过期记录顺带惰性清理) */
  check(key: string): RateLimitState;
  /** 记一次失败; 达到阈值进入锁定 */
  fail(key: string): RateLimitState;
  /** 成功后清除失败计数 */
  reset(key: string): void;
  /** 当前跟踪的 key 数 (测试/观测用) */
  size(): number;
}

export function createMemoryRateLimiter(options: RateLimiterOptions = {}): MemoryRateLimiter {
  const maxFails = options.maxFails ?? 5;
  const lockMs = options.lockMs ?? 15 * 60 * 1000;
  const records = new Map<string, { n: number; until: number }>();

  const state = (rec?: { n: number; until: number }): RateLimitState => {
    if (!rec) return { locked: false, retryAfterMin: 0, remaining: maxFails };
    const now = Date.now();
    if (rec.until > now) {
      return { locked: true, retryAfterMin: Math.ceil((rec.until - now) / 60000), remaining: 0 };
    }
    return { locked: false, retryAfterMin: 0, remaining: Math.max(0, maxFails - rec.n) };
  };

  return {
    check(key) {
      const rec = records.get(key);
      if (rec && rec.until !== 0 && rec.until <= Date.now()) records.delete(key);
      return state(records.get(key));
    },
    fail(key) {
      const rec = records.get(key) ?? { n: 0, until: 0 };
      rec.n += 1;
      if (rec.n >= maxFails) {
        rec.until = Date.now() + lockMs;
        rec.n = 0;
      }
      records.set(key, rec);
      return state(rec);
    },
    reset(key) {
      records.delete(key);
    },
    size() {
      return records.size;
    },
  };
}

// ── 服务定义 (插件形态, ctx.call 使用) ───────────────────────────

export interface RateLimitRequest {
  /** check=查询 / fail=记失败并查询 / reset=清除 */
  action: "check" | "fail" | "reset";
  /** 限流键 (如 "ip|email") */
  key: string;
}

export interface RateLimitResponse {
  locked: boolean;
  retryAfterMin: number;
  remaining: number;
}

export const rateLimitService: ServiceDefinition<RateLimitRequest, RateLimitResponse> = {
  id: "@infrastructure/rate-limit",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "内存限流器：失败计数 + 锁定 (登录防暴力破解等)",
};

const sharedLimiter = createMemoryRateLimiter();

const rateLimitProvider: Provider<RateLimitRequest, RateLimitResponse> = {
  service: rateLimitService,
  name: "infrastructure-rate-limit-memory",
  state: PluginState.Active,
  async execute(
    request: RateLimitRequest,
    _ctx: SeamContext,
  ): Promise<Result<RateLimitResponse>> {
    let s: RateLimitState;
    if (request.action === "fail") s = sharedLimiter.fail(request.key);
    else if (request.action === "reset") {
      sharedLimiter.reset(request.key);
      s = sharedLimiter.check(request.key);
    } else s = sharedLimiter.check(request.key);
    return ok(s);
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: `rate-limit tracking ${sharedLimiter.size()} keys`, checkedAt: new Date().toISOString() };
  },
};

export { rateLimitProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const rateLimitManifest: PluginManifest = {
  name: "@infrastructure/rate-limit",
  layer: LayerId.Infrastructure,
  description: "底座基础层：内存限流器（失败计数 + 锁定）",
  version: "0.1.0",
  provides: [rateLimitService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
