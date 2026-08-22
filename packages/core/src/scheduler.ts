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

import type { CapabilityRef, HealthStatus } from "./types.js";
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
  /** Force an immediate health check cycle */
  checkNow(): Promise<SchedulingDecision[]>;
  /** Update the scheduling policy at runtime */
  setPolicy(policy: Partial<SchedulingPolicy>): void;
}

// ── In-Process Scheduler Implementation ──────────────────────────

export class InProcessScheduler implements Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failureCounts = new Map<string, number>();
  private policy: SchedulingPolicy = DEFAULT_POLICY;
  private unsubscribe?: () => void;

  constructor(
    private readonly adapter: KernelAdapter,
    private readonly registry: SeamRegistry,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkNow().catch(() => {});
    }, this.policy.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
  }

  async checkNow(): Promise<SchedulingDecision[]> {
    const decisions: SchedulingDecision[] = [];
    const handles = this.adapter.carriers.list();

    for (const handle of handles) {
      const health = await this.adapter.carriers.health(handle);

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

  setPolicy(policy: Partial<SchedulingPolicy>): void {
    this.policy = { ...this.policy, ...policy };
    // Restart timer if interval changed
    if (policy.intervalMs && this.timer) {
      this.stop();
      this.start();
    }
  }
}
