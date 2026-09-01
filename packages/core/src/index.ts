/**
 * @aigility-harness/core — public entry point.
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

// ── BusBridge (跨进程消息总线契约, 阶段 2) ────────────────────────
export {
  BUS_PROTOCOL,
  BUS_KINDS,
  eventTopic,
  createBusBridge,
} from "./bus-bridge.js";
export type {
  BusEnvelope,
  BusBridge,
  BusKind,
} from "./bus-bridge.js";

// ── TaskQueue (任务队列契约, PG 单库化) ───────────────────────────
export { taskQueueName } from "./task-queue.js";
export type {
  QueueMessage,
  TaskQueue,
} from "./task-queue.js";

// ── VectorStore (向量检索契约, PG 单库化) ─────────────────────────
export type {
  VectorPoint,
  VectorSearchHit,
  VectorMetric,
  VectorStore,
} from "./vector-store.js";

// ── LLM Inference 契约（跨层共享的内部标准） ──────────────────────
export type {
  ToolCall,
  ChatMessage,
  LlmInferenceRequest,
  LlmInferenceResponse,
} from "./llm-contract.js";
export { llmInferenceRef } from "./llm-contract.js";

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