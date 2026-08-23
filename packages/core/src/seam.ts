/**
 * Capability Seam — the architectural soul of the system.
 *
 * A Seam is a contract between a Consumer (who needs a capability) and a
 * Provider (who implements it).  The Seam itself is a stable, versioned
 * interface that never changes its shape — only new versions are added.
 *
 * This is the kernel-agnostic abstraction.  The KernelAdapter is responsible
 * for bridging Seam registration/resolution to the underlying runtime
 * (e.g. DSH/Cordis plugin system).
 */

import type {
  CapabilityId,
  CapabilityRef,
  HealthStatus,
  LayerId,
  PluginState,
  Result,
  SystemEvent,
} from "./types.js";

// ── Service Definition (the contract) ────────────────────────────

/**
 * A `ServiceDefinition` declares a capability contract.
 *
 * It is identified by a unique `id` and a semantic version.  The `schema`
 * field holds a JSON Schema (or equivalent) describing the request/response
 * shapes, allowing runtime validation.
 *
 * This object is **immutable once published**.  Breaking changes require a
 * new `id` or a major version bump.
 */
export interface ServiceDefinition<TRequest = unknown, TResponse = unknown> {
  id: CapabilityId;
  version: string;
  layer: LayerId;
  description: string;
  /** JSON Schema for the request payload */
  requestSchema?: Record<string, unknown>;
  /** JSON Schema for the response payload */
  responseSchema?: Record<string, unknown>;
}

// ── Provider (the implementation) ────────────────────────────────

/**
 * A `Provider` is a concrete implementation of a `ServiceDefinition`.
 *
 * Providers are registered at runtime and can be dynamically swapped
 * without notifying consumers — this is the "hot replacement" mechanism.
 */
export interface Provider<TRequest = unknown, TResponse = unknown> {
  /** The service this provider implements */
  service: ServiceDefinition<TRequest, TResponse>;

  /** A human-readable name for this specific implementation */
  name: string;

  /** Current lifecycle state */
  state: PluginState;

  /** Execute the capability */
  execute(request: TRequest, ctx: SeamContext): Promise<Result<TResponse>>;

  /** Health probe — called periodically by the scheduler */
  health(): Promise<HealthStatus>;

  /** Graceful shutdown */
  dispose?(): Promise<void>;
}

// ── Consumer (the caller) ────────────────────────────────────────

/**
 * A `Consumer` declares a dependency on a capability.
 *
 * At runtime it resolves to a specific `Provider` via the Seam registry.
 * If the bound provider becomes unhealthy, the scheduler can rebind to
 * another provider transparently.
 */
export interface Consumer<TRequest = unknown, TResponse = unknown> {
  ref: CapabilityRef;
  /** The layer this consumer belongs to */
  layer: LayerId;

  /**
   * Invoke the bound provider.
   * The Seam runtime handles provider selection, health checks, and
   * automatic failover.
   */
  call(request: TRequest, ctx: SeamContext): Promise<Result<TResponse>>;
}

// ── Seam Context ─────────────────────────────────────────────────

/**
 * Per-invocation context passed to every `Provider.execute` and
 * `Consumer.call`.  This carries session state, trace IDs, and the
 * effect collector — without exposing any kernel-specific globals.
 */
export interface SeamContext {
  /** Unique session ID */
  sessionId: string;
  /** Trace ID for distributed tracing */
  traceId: string;
  /** The layer initiating this call */
  callerLayer: LayerId;

  /** Record a reversible side effect */
  addEffect(description: string, rollback: () => Promise<void>): string;

  /** Emit a system event on the bus */
  emit(event: Omit<SystemEvent, "seq" | "timestamp">): void;

  /** Read a value from session-scoped key-value store */
  getState<T>(key: string): T | undefined;
  /** Write a value to session-scoped key-value store */
  setState<T>(key: string, value: T): void;

  /**
   * Invoke another capability by reference.  The seam resolves the
   * currently-bound provider (version negotiation + failover), then executes
   * it with a child context that shares this session/trace so one logical
   * request stays one trace across layers.
   */
  call<TReq, TRes>(ref: CapabilityRef, request: TReq): Promise<Result<TRes>>;
}

// ── Seam Registry ────────────────────────────────────────────────

/**
 * The central registry where providers are registered and consumers
 * resolve their dependencies.
 *
 * This interface is implemented by the KernelAdapter — the core never
 * assumes a specific registry implementation.
 */
export interface SeamRegistry {
  /** Register a provider for a service definition */
  register<TReq, TRes>(
    service: ServiceDefinition<TReq, TRes>,
    provider: Provider<TReq, TRes>,
  ): Promise<Result<void>>;

  /** Unregister a provider (graceful) */
  unregister(providerName: string): Promise<Result<void>>;

  /** Resolve a consumer to its currently-bound provider */
  resolve<TReq, TRes>(ref: CapabilityRef): Promise<Result<Provider<TReq, TRes>>>;

  /** List all registered providers for a given capability */
  listProviders(id: CapabilityId): Provider[];

  /** Subscribe to registry events (register/unregister/rebind) */
  onEvent(callback: (event: SeamRegistryEvent) => void): () => void;
}

export type SeamRegistryEvent =
  | { type: "registered"; providerName: string; serviceId: CapabilityId }
  | { type: "unregistered"; providerName: string; serviceId: CapabilityId }
  | { type: "rebound"; ref: CapabilityRef; fromProvider: string; toProvider: string };
