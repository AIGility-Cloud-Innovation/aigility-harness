/**
 * @aigility-arch/kernel-dsh — DSH (Dynamic Substrate Host) kernel adapter.
 *
 * Implements the `KernelAdapter` contract from `@aigility-arch/core` over a
 * Cordis 4.0 runtime. This is the concrete bridge between the five-layer
 * architecture and the Cordis kernel — the only place that imports Cordis.
 */

export { DshKernelAdapter } from "./kernel-adapter.js";
export { CordisSeamRegistry } from "./seam-registry.js";
export { CordisEventBus } from "./event-bus.js";
export { InMemoryEffectManager } from "./effect-manager.js";
export { DshCarrierManager } from "./carrier-manager.js";
export { DshSeamContext } from "./seam-context.js";
export { EffectStore } from "./effect-store.js";
export { satisfies } from "./semver.js";
