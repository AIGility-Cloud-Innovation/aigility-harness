/**
 * Core type definitions for the Aigility Architecture.
 *
 * These types are kernel-agnostic: they do not depend on DSH, Cordis, or any
 * specific runtime.  All five layers and the KernelAdapter contract operate
 * exclusively on these types.
 */

// ── Layer Identity ────────────────────────────────────────────────

export enum LayerId {
  /** 第1层：认知决策核心层（大脑） */
  Cognitive = "cognitive",
  /** 第2层：多模态感知交互层（感官） */
  Perception = "perception",
  /** 第3层：编排规划层（小脑） */
  Orchestration = "orchestration",
  /** 第4层：行动执行工具层（手脚） */
  Action = "action",
  /** 第5层：底座兼容基础层（系统地基） */
  Infrastructure = "infrastructure",
}

export const LAYER_ORDER: readonly LayerId[] = [
  LayerId.Cognitive,
  LayerId.Perception,
  LayerId.Orchestration,
  LayerId.Action,
  LayerId.Infrastructure,
] as const;

// ── Carrier (运行载体) ───────────────────────────────────────────

export enum CarrierKind {
  /** 子线程（同进程插件） */
  Thread = "thread",
  /** 附属子进程（父进程托管） */
  Subprocess = "subprocess",
  /** 本机独立守护进程 */
  Daemon = "daemon",
  /** 独立端口网络服务 */
  NetworkService = "network-service",
}

// ── Environment / Mode ───────────────────────────────────────────

export enum RunMode {
  /** 原型模式：全部进程内插件，内存级 Provider */
  Prototype = "prototype",
  /** 生产模式：分布式部署，独立守护进程 */
  Production = "production",
}

// ── Capability Identifier ────────────────────────────────────────

/**
 * A globally-unique capability identifier.
 * Format: `@scope/capability-name` (e.g. `@cognitive/llm-inference`).
 */
export type CapabilityId = string;

/**
 * A versioned capability reference, used by Consumers to declare
 * which Provider version they depend on.
 */
export interface CapabilityRef {
  id: CapabilityId;
  /** SemVer range, e.g. `^1.0.0` */
  versionRange: string;
}

// ── Plugin Lifecycle ─────────────────────────────────────────────

export enum PluginState {
  Registered = "registered",
  Initializing = "initializing",
  Active = "active",
  Degraded = "degraded",
  Disposing = "disposing",
  Disposed = "disposed",
  Error = "error",
}

// ── Events ───────────────────────────────────────────────────────

export interface SystemEvent {
  /** Monotonic sequence number within the session */
  seq: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type, e.g. `plugin.activated`, `capability.bound` */
  type: string;
  /** The layer that emitted this event */
  layer: LayerId;
  /** Arbitrary structured payload */
  payload: unknown;
  /** Trace ID for distributed tracing */
  traceId?: string;
}

// ── Effect (副作用追踪) ──────────────────────────────────────────

/**
 * A reversible side effect.  The kernel tracks these so they can be
 * rolled back on failure or during disposal.
 */
export interface Effect {
  id: string;
  description: string;
  /** Rollback function; called by the kernel on undo/dispose */
  rollback: () => Promise<void>;
}

// ── Health ───────────────────────────────────────────────────────

export interface HealthStatus {
  healthy: boolean;
  /** 0–1, where 1 is fully loaded */
  load?: number;
  /** MB of memory currently in use */
  memoryUsageMb?: number;
  /** GPU memory in MB, if applicable */
  gpuMemoryMb?: number;
  /** Human-readable detail */
  detail?: string;
  /** Timestamp of last health check */
  checkedAt: string;
}

// ── Result ───────────────────────────────────────────────────────

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
