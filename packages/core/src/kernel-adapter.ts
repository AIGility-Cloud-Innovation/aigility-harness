/**
 * KernelAdapter — the single abstraction boundary between the five-layer
 * architecture and any underlying runtime kernel (DSH/Cordis, or future
 * alternatives).
 *
 * The core principle: **the five layers and the Seam registry never import
 * anything from a specific kernel**.  They only depend on this interface.
 *
 * To support a new kernel, implement this interface and register it at
 * bootstrap.  No layer code changes.
 */

import type {
  CarrierKind,
  HealthStatus,
  LayerId,
  PluginState,
  Result,
  RunMode,
  SystemEvent,
} from "./types.js";
import type { SeamRegistry, SeamContext } from "./seam.js";
import type { LayerPlugin } from "./layer-plugin.js";

// ── Kernel Info ──────────────────────────────────────────────────

export interface KernelInfo {
  /** Kernel name, e.g. "dsh-cordis", "custom" */
  name: string;
  /** Kernel version, e.g. "0.1.0-alpha.5" */
  version: string;
  /** Supported carrier kinds */
  supportedCarriers: CarrierKind[];
}

// ── Plugin Handle ────────────────────────────────────────────────

/**
 * An opaque handle to a plugin instance managed by the kernel.
 * The kernel implementation defines the concrete shape internally.
 */
export interface PluginHandle {
  id: string;
  name: string;
  layer: LayerId;
  carrier: CarrierKind;
  state: PluginState;
}

// ── Carrier Manager ──────────────────────────────────────────────

/**
 * Manages the four carrier kinds.  The KernelAdapter delegates carrier
 * lifecycle operations to this sub-interface.
 */
export interface CarrierManager {
  /** Launch a plugin in the specified carrier */
  launch(
    plugin: LayerPlugin,
    carrier: CarrierKind,
  ): Promise<Result<PluginHandle>>;

  /** Stop a plugin instance */
  stop(handle: PluginHandle): Promise<Result<void>>;

  /** Migrate a plugin from one carrier to another (hot) */
  migrate(
    handle: PluginHandle,
    toCarrier: CarrierKind,
  ): Promise<Result<PluginHandle>>;

  /** Query health of a plugin instance */
  health(handle: PluginHandle): Promise<HealthStatus>;

  /** List all active plugin handles */
  list(): PluginHandle[];
}

// ── Event Bus ────────────────────────────────────────────────────

/**
 * The inter-layer event bus.  In prototype mode this is an in-process
 * EventEmitter; in production mode it bridges to NATS-JetStream.
 */
export interface EventBus {
  publish(event: SystemEvent): Promise<void>;
  subscribe(
    layer: LayerId,
    callback: (event: SystemEvent) => void,
  ): () => void;
  /** Replay events from a given sequence number (event sourcing) */
  replay(fromSeq: number): AsyncIterable<SystemEvent>;
}

// ── Effect Manager ───────────────────────────────────────────────

/**
 * Tracks reversible side effects for rollback.  In prototype mode this
 * is in-memory; in production it coordinates across processes.
 */
export interface EffectManager {
  /** Record an effect with its rollback function */
  record(
    sessionId: string,
    description: string,
    rollback: () => Promise<void>,
  ): Promise<string>;

  /** Roll back all effects for a session, in reverse order */
  rollbackAll(sessionId: string): Promise<Result<void>>;

  /** Roll back a specific effect by ID */
  rollbackOne(effectId: string): Promise<Result<void>>;
}

// ── KernelAdapter (the contract) ─────────────────────────────────

/**
 * The complete kernel adapter contract.
 *
 * **Implementation rule**: every method must be pure delegation — no
 * business logic, no layer-specific behavior.  The adapter only translates
 * between the architecture's abstractions and the kernel's primitives.
 */
export interface KernelAdapter {
  readonly info: KernelInfo;
  readonly registry: SeamRegistry;
  readonly carriers: CarrierManager;
  readonly events: EventBus;
  readonly effects: EffectManager;

  /** Current run mode */
  getMode(): RunMode;

  /** Create a SeamContext for a new invocation */
  createContext(sessionId: string, callerLayer: LayerId): SeamContext;

  /** Initialize the kernel */
  init(config: KernelConfig): Promise<Result<void>>;

  /** Graceful shutdown */
  shutdown(): Promise<Result<void>>;

  /** Is the kernel ready to accept requests? */
  isReady(): boolean;
}

// ── Kernel Config ────────────────────────────────────────────────

export interface KernelConfig {
  mode: RunMode;
  /** Profile name, e.g. "default", "production" */
  profile: string;
  /** NATS URL for production mode (ignored in prototype) */
  natsUrl?: string;
  /** Enable automatic hot replacement */
  autoHotSwap: boolean;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs: number;
}
