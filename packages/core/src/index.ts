/**
 * @aigility-arch/core — public entry point.
 *
 * Exports the kernel-agnostic abstractions that every layer, adapter,
 * and the bootstrap system depend on.
 */

// ── Types ─────────────────────────────────────────────────────────
export {
  LayerId,
  LAYER_ORDER,
  CarrierKind,
  RunMode,
  PluginState,
  ok,
  err,
} from "./types.js";
export type {
  CapabilityId,
  CapabilityRef,
  SystemEvent,
  Effect,
  HealthStatus,
  Result,
} from "./types.js";

// ── KernelAdapter contract ────────────────────────────────────────
export type {
  KernelAdapter,
  KernelConfig,
  KernelInfo,
  CarrierManager,
  EventBus,
  EffectManager,
  PluginHandle,
} from "./kernel-adapter.js";

// ── Capability Seam ───────────────────────────────────────────────
export type {
  ServiceDefinition,
  Provider,
  Consumer,
  SeamContext,
  SeamRegistry,
  SeamRegistryEvent,
} from "./seam.js";

// ── LayerPlugin ───────────────────────────────────────────────────
export type {
  LayerPlugin,
  PluginManifest,
  LayerDescriptor,
} from "./layer-plugin.js";
export { LAYER_DESCRIPTORS } from "./layer-plugin.js";

// ── Bootstrap ─────────────────────────────────────────────────────
export type { BootstrapConfig } from "./bootstrap.js";
export { bootstrap, shutdown } from "./bootstrap.js";

// ── Scheduler ─────────────────────────────────────────────────────
export type {
  Scheduler,
  SchedulingDecision,
  SchedulingPolicy,
} from "./scheduler.js";
export { InProcessScheduler, DEFAULT_POLICY } from "./scheduler.js";