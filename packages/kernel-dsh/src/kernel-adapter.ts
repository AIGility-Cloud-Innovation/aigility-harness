/**
 * DshKernelAdapter — the Cordis-backed implementation of `KernelAdapter`.
 *
 * This is the single concrete adapter that bridges the five-layer
 * architecture's abstractions to Cordis 4.0 runtime primitives. It contains
 * **no business logic** — only translation:
 *
 *   KernelAdapter member   →   Cordis primitive
 *   ─────────────────────────────────────────────
 *   registry               →   ctx.provide / ctx.get  (via CordisSeamRegistry)
 *   events                 →   ctx.on / ctx.emit      (via CordisEventBus)
 *   effects                →   in-memory EffectStore  (via InMemoryEffectManager)
 *   carriers               →   plugin onLoad/onUnload (via DshCarrierManager)
 *   createContext          →   DshSeamContext
 *   init / shutdown        →   Cordis Context lifecycle (fiber.dispose)
 *   getMode / isReady      →   local state flags
 */

import { Context } from "@cordisjs/core";
import type {
  CarrierKind,
  LayerId,
  Result,
  RunMode,
} from "@aigility-arch/core";
import type {
  KernelAdapter,
  KernelConfig,
  KernelInfo,
} from "@aigility-arch/core";
import type { SeamContext, SeamRegistry } from "@aigility-arch/core";
import { err, ok } from "@aigility-arch/core";
import { CordisSeamRegistry } from "./seam-registry.js";
import { CordisEventBus } from "./event-bus.js";
import { EffectStore } from "./effect-store.js";
import { InMemoryEffectManager } from "./effect-manager.js";
import { DshCarrierManager } from "./carrier-manager.js";
import { DshSeamContext } from "./seam-context.js";

const KERNEL_NAME = "dsh-cordis";
const KERNEL_VERSION = "0.1.0";

const SUPPORTED_CARRIERS: CarrierKind[] = [
  "thread" as CarrierKind,
  "subprocess" as CarrierKind,
];

export class DshKernelAdapter implements KernelAdapter {
  readonly info: KernelInfo = {
    name: KERNEL_NAME,
    version: KERNEL_VERSION,
    supportedCarriers: SUPPORTED_CARRIERS,
  };

  private readonly ctx: Context;
  private readonly effectStore: EffectStore;
  readonly registry: SeamRegistry;
  readonly carriers: DshCarrierManager;
  readonly events: CordisEventBus;
  readonly effects: InMemoryEffectManager;

  private mode: RunMode = "prototype" as RunMode;
  private ready = false;
  private disposed = false;

  constructor() {
    this.ctx = new Context();
    this.effectStore = new EffectStore();
    this.registry = new CordisSeamRegistry(this.ctx);
    this.events = new CordisEventBus(this.ctx);
    this.effects = new InMemoryEffectManager(this.effectStore);
    this.carriers = new DshCarrierManager((sessionId, layer) =>
      this.createContext(sessionId, layer),
    );
  }

  getMode(): RunMode {
    return this.mode;
  }

  createContext(sessionId: string, callerLayer: LayerId): SeamContext {
    const traceId = `trace-${sessionId}`;
    return new DshSeamContext(
      sessionId,
      callerLayer,
      traceId,
      this.effectStore,
      this.events,
    );
  }

  async init(config: KernelConfig): Promise<Result<void>> {
    if (this.disposed) {
      return err("kernel has been shut down");
    }
    this.mode = config.mode;
    this.ready = true;
    return ok(undefined);
  }

  async shutdown(): Promise<Result<void>> {
    if (this.disposed) {
      return ok(undefined);
    }
    this.ready = false;
    this.disposed = true;

    // Dispose the Cordis root fiber — runs all registered disposables
    // (service provides, event listeners, plugin effects) in reverse order.
    try {
      await this.ctx.fiber.dispose();
    } catch (e) {
      return err(String(e));
    }
    return ok(undefined);
  }

  isReady(): boolean {
    return this.ready && !this.disposed;
  }
}
