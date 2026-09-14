/**
 * Scheduler — the intelligent automatic hot-replacement controller.
 *
 * Monitors all providers' health and automatically rebinds consumers to
 * healthy providers when the current one degrades or fails.
 *
 * In prototype mode this is a simple timer-based poller.
 * In production mode it subscribes to NATS health events and can
 * coordinate cross-machine failover.
 */

import { LayerId, type CapabilityRef, type HealthStatus } from "./types.js";
import type { Provider, SeamRegistry } from "./seam.js";
import type { KernelAdapter } from "./kernel-adapter.js";

// ── Scheduling Decision ──────────────────────────────────────────

export type SchedulingDecision =
  | { type: "noop" }
  | { type: "rebind"; ref: CapabilityRef; from: string; to: string; reason: string }
  | { type: "restart"; providerName: string; reason: string }
  | { type: "alert"; message: string };

// ── Scheduling Policy ────────────────────────────────────────────

export interface SchedulingPolicy {
  /** Health check interval in milliseconds */
  intervalMs: number;
  /** Load threshold above which to consider rebinding (0–1) */
  loadThreshold: number;
  /** Consecutive failed health checks before failover */
  failureThreshold: number;
  /** Whether to attempt restart before rebind */
  tryRestartFirst: boolean;
}

export const DEFAULT_POLICY: SchedulingPolicy = {
  intervalMs: 5_000,
  loadThreshold: 0.85,
  failureThreshold: 3,
  tryRestartFirst: true,
};

// ── Scheduler ────────────────────────────────────────────────────

export interface Scheduler {
  /** Start periodic health monitoring */
  start(): void;
  /** Stop monitoring */
  stop(): void;
  /** Force an immediate health check cycle (pure: does not apply decisions) */
  checkNow(): Promise<SchedulingDecision[]>;
  /** Execute decisions (rebind via SeamRegistry; every decision is published as a SystemEvent) */
  apply(decisions: SchedulingDecision[]): Promise<void>;
  /** autoHotSwap 开关：开启后调度循环自动应用决策 (bootstrap 从 KernelConfig 注入) */
  setAutoApply(on: boolean): void;
  /** Update the scheduling policy at runtime */
  setPolicy(policy: Partial<SchedulingPolicy>): void;
}

// ── In-Process Scheduler Implementation ──────────────────────────

/** Health probe timeout: a provider whose health() hangs counts as unhealthy */
const PROBE_TIMEOUT_MS = 3_000;

export class InProcessScheduler implements Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 插件载体级连续失败计数 (handle 名 → 次数) */
  private failureCounts = new Map<string, number>();
  /** Provider 级连续失败计数 (provider 名 → 次数) */
  private providerFailures = new Map<string, number>();
  /** 故障转移绑定记录 (serviceId → 当前 pin 住的 provider 名; null = 默认绑定) */
  private preferred = new Map<string, string | null>();
  /** 各能力默认绑定的 provider 名 (listProviders 首个, apply 判断 failback 用) */
  private defaultHeads = new Map<string, string>();
  /** 默认绑定 provider 连续健康次数 (serviceId → 次数), 达标后 failback */
  private headHealthyStreak = new Map<string, number>();
  private policy: SchedulingPolicy = DEFAULT_POLICY;
  private autoApply = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly adapter: KernelAdapter,
    private readonly registry: SeamRegistry,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void (async () => {
        const decisions = await this.checkNow().catch(() => []);
        if (this.autoApply && decisions.length > 0) {
          await this.apply(decisions).catch(() => {});
        }
      })();
    }, this.policy.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
  }

  setAutoApply(on: boolean): void {
    this.autoApply = on;
  }

  setPolicy(policy: Partial<SchedulingPolicy>): void {
    this.policy = { ...this.policy, ...policy };
    // Restart timer if interval changed
    if (policy.intervalMs && this.timer) {
      this.stop();
      this.start();
    }
  }

  async checkNow(): Promise<SchedulingDecision[]> {
    const decisions: SchedulingDecision[] = [];
    decisions.push(...(await this.checkPluginHandles()));
    decisions.push(...(await this.checkProviders()));
    return decisions;
  }

  async apply(decisions: SchedulingDecision[]): Promise<void> {
    for (const d of decisions) {
      if (d.type === "rebind") {
        // 回切到默认绑定时清除覆盖 (默认绑定 = 内核默认选择, 见 rebind 契约);
        // 否则 pin 住目标 provider
        const target = d.to === this.defaultHeads.get(d.ref.id) ? null : d.to;
        await this.registry.rebind(d.ref, target).catch(() => {});
        this.preferred.set(d.ref.id, target);
      }
      await this.publish(d);
    }
  }

  // ── 插件载体级扫描 (原有行为: 连续失败告警) ─────────────────────

  private async checkPluginHandles(): Promise<SchedulingDecision[]> {
    const decisions: SchedulingDecision[] = [];
    for (const handle of this.adapter.carriers.list()) {
      const health: HealthStatus = await this.adapter.carriers.health(handle).catch(() => ({
        healthy: false,
        checkedAt: new Date().toISOString(),
      }));

      if (!health.healthy) {
        const failures = (this.failureCounts.get(handle.name) ?? 0) + 1;
        this.failureCounts.set(handle.name, failures);
        if (failures >= this.policy.failureThreshold) {
          decisions.push({
            type: "alert",
            message: `Provider ${handle.name} failed ${failures} consecutive health checks`,
          });
          this.failureCounts.set(handle.name, 0);
        }
      } else if (health.load && health.load > this.policy.loadThreshold) {
        decisions.push({
          type: "alert",
          message: `Provider ${handle.name} load ${health.load} exceeds threshold ${this.policy.loadThreshold}`,
        });
      } else {
        this.failureCounts.set(handle.name, 0);
      }
    }
    return decisions;
  }

  // ── Provider 级扫描: 健康探测 → rebind / failback 决策 ──────────

  /**
   * 同能力多 Provider 的故障转移:
   *  - 当前绑定 provider 连续失败达阈值 → rebind 到同级健康 provider;
   *  - 无健康同级 → alert (restart 需载体级重载, 归阶段 3);
   *  - 故障转移后, 默认绑定 provider 连续健康达阈值 → failback 回默认绑定。
   * 绑定经 SeamRegistry.rebind 显式覆盖, 不重排注册顺序。
   */
  private async checkProviders(): Promise<SchedulingDecision[]> {
    const decisions: SchedulingDecision[] = [];
    const services = this.registry.listAllServices();
    // 按能力分组 (同一 service 多 provider)
    const byId = new Map<string, { service: (typeof services)[number]["service"]; providers: Provider[] }>();
    for (const s of services) {
      const list = byId.get(s.service.id);
      if (list) {
        if (!list.providers.some((p) => p.name === s.providerName)) {
          const extra = this.registry.listProviders(s.service.id).find((p) => p.name === s.providerName);
          if (extra) list.providers.push(extra);
        }
      } else {
        byId.set(s.service.id, {
          service: s.service,
          providers: this.registry.listProviders(s.service.id),
        });
      }
    }

    for (const [id, { service, providers }] of byId) {
      if (providers.length === 0) continue;

      // 本轮全量探测一次, 结果缓存复用
      const healthMap = new Map<string, HealthStatus>();
      await Promise.all(
        providers.map(async (p) => {
          healthMap.set(p.name, await probeHealth(p, PROBE_TIMEOUT_MS));
        }),
      );

      // 默认绑定 = 内核默认选择 (listProviders 首个; 顺序由内核语义决定)
      const head = providers[0]!;
      this.defaultHeads.set(id, head.name);
      const boundName = this.preferred.get(id) ?? head.name;
      const bound = providers.find((p) => p.name === boundName) ?? head;
      const boundHealth = healthMap.get(bound.name)!;

      if (!boundHealth.healthy) {
        this.headHealthyStreak.set(id, 0);
        const failures = (this.providerFailures.get(bound.name) ?? 0) + 1;
        this.providerFailures.set(bound.name, failures);
        if (failures < this.policy.failureThreshold) continue;

        const sibling = providers.find(
          (p) => p.name !== bound.name && healthMap.get(p.name)!.healthy,
        );
        if (sibling) {
          // 已 pin 在目标上则不重复出决策
          if (this.preferred.get(id) !== sibling.name) {
            decisions.push({
              type: "rebind",
              ref: { id, versionRange: `^${service.version}` },
              from: bound.name,
              to: sibling.name,
              reason: `bound provider ${bound.name} failed ${failures} consecutive health checks; failover to healthy sibling`,
            });
          }
        } else {
          decisions.push({
            type: "alert",
            message: `Capability ${id}: bound provider ${bound.name} failed ${failures} consecutive health checks and no healthy sibling available (restart requires carrier-level reload)`,
          });
          this.providerFailures.set(bound.name, 0);
        }
      } else {
        this.providerFailures.set(bound.name, 0);
        // failback: 曾故障转移, 且默认绑定连续健康达标 → 回切默认绑定
        if (this.preferred.get(id) && bound.name !== head.name) {
          const streak = (this.headHealthyStreak.get(id) ?? 0) + 1;
          this.headHealthyStreak.set(id, streak);
          if (streak >= this.policy.failureThreshold) {
            decisions.push({
              type: "rebind",
              ref: { id, versionRange: `^${service.version}` },
              from: bound.name,
              to: head.name,
              reason: `default provider ${head.name} healthy for ${streak} consecutive checks; failing back`,
            });
            this.headHealthyStreak.set(id, 0);
          }
        } else {
          this.headHealthyStreak.set(id, 0);
        }
      }
    }
    return decisions;
  }

  private async publish(d: SchedulingDecision): Promise<void> {
    try {
      await this.adapter.events.publish({
        seq: 0,
        timestamp: new Date().toISOString(),
        type: `scheduler.${d.type}`,
        layer: LayerId.Infrastructure,
        payload: d,
      });
    } catch {
      // 事件总线不可用不影响调度决策本身
    }
  }
}

/** 带超时的健康探测: 挂死/抛错的 provider 一律按不健康处理 */
async function probeHealth(p: Provider, timeoutMs: number): Promise<HealthStatus> {
  try {
    return await Promise.race([
      p.health(),
      new Promise<HealthStatus>((_, reject) =>
        setTimeout(() => reject(new Error("health probe timeout")), timeoutMs),
      ),
    ]);
  } catch {
    return { healthy: false, detail: "health probe failed/timeout", checkedAt: new Date().toISOString() };
  }
}
