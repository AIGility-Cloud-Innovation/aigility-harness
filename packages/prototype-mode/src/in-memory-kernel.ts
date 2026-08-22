/**
 * 内存版 KernelAdapter —— 原型模式运行时
 *
 * 全进程内插件，内存级 Provider：
 *  - SeamRegistry：Map<CapabilityId, Provider[]>
 *  - EventBus：EventEmitter
 *  - EffectManager：Map<sessionId, Effect[]>
 *  - CarrierManager：Thread 载体内联，其余载体报「原型模式不支持」
 */

import { EventEmitter } from "node:events";
import {
  LayerId,
  CarrierKind,
  RunMode,
  PluginState,
  ok,
  err,
} from "@aigility-arch/core";
import type {
  KernelAdapter,
  KernelConfig,
  KernelInfo,
  CarrierManager,
  EventBus,
  EffectManager,
  PluginHandle,
  SeamRegistry,
  SeamRegistryEvent,
  SeamContext,
  Provider,
  ServiceDefinition,
  SystemEvent,
  Effect,
  Result,
  HealthStatus,
} from "@aigility-arch/core";
import type { LayerPlugin } from "@aigility-arch/core";

// ── 内存 SeamRegistry ────────────────────────────────────────────

class InMemorySeamRegistry implements SeamRegistry {
  private providersByService = new Map<string, Provider[]>();
  private listeners = new Set<(e: SeamRegistryEvent) => void>();

  async register<TReq, TRes>(
    service: ServiceDefinition<TReq, TRes>,
    provider: Provider<TReq, TRes>,
  ): Promise<Result<void>> {
    const list = this.providersByService.get(service.id) ?? [];
    if (list.some((p) => p.name === provider.name)) {
      return err(`Provider ${provider.name} already registered for ${service.id}`);
    }
    list.push(provider as Provider);
    this.providersByService.set(service.id, list);
    for (const cb of this.listeners) {
      cb({ type: "registered", providerName: provider.name, serviceId: service.id });
    }
    return ok(undefined);
  }

  async unregister(providerName: string): Promise<Result<void>> {
    let removed = false;
    for (const [serviceId, list] of this.providersByService) {
      const idx = list.findIndex((p) => p.name === providerName);
      if (idx >= 0) {
        const svcId = serviceId;
        list.splice(idx, 1);
        removed = true;
        for (const cb of this.listeners) {
          cb({ type: "unregistered", providerName, serviceId: svcId });
        }
      }
    }
    if (!removed) return err(`Provider ${providerName} not found`);
    return ok(undefined);
  }

  async resolve<TReq, TRes>(
    ref: { id: string; versionRange: string },
  ): Promise<Result<Provider<TReq, TRes>>> {
    const list = this.providersByService.get(ref.id);
    if (!list || list.length === 0) {
      return err(`No provider registered for capability ${ref.id}`);
    }
    // 取第一个可用 provider（原型模式不做复杂版本协商）
    return ok(list[0] as Provider<TReq, TRes>);
  }

  listProviders(id: string): Provider[] {
    return this.providersByService.get(id) ?? [];
  }

  onEvent(callback: (event: SeamRegistryEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}

// ── 内存 EventBus ────────────────────────────────────────────────

class InMemoryEventBus implements EventBus {
  private emitter = new EventEmitter();
  private events: SystemEvent[] = [];
  private seq = 0;

  async publish(event: SystemEvent): Promise<void> {
    this.events.push(event);
    this.emitter.emit(event.layer, event);
  }

  subscribe(layer: LayerId, callback: (event: SystemEvent) => void): () => void {
    this.emitter.on(layer, callback);
    return () => {
      this.emitter.off(layer, callback);
    };
  }

  async *replay(fromSeq: number): AsyncIterable<SystemEvent> {
    for (const event of this.events) {
      if (event.seq >= fromSeq) {
        yield event;
      }
    }
  }
}

// ── 内存 EffectManager ───────────────────────────────────────────

class InMemoryEffectManager implements EffectManager {
  private effectsBySession = new Map<string, Effect[]>();
  private effectById = new Map<string, Effect>();
  private counter = 0;

  async record(
    sessionId: string,
    description: string,
    rollback: () => Promise<void>,
  ): Promise<string> {
    const id = `effect-${++this.counter}`;
    const effect: Effect = { id, description, rollback };
    const list = this.effectsBySession.get(sessionId) ?? [];
    list.push(effect);
    this.effectsBySession.set(sessionId, list);
    this.effectById.set(id, effect);
    return id;
  }

  async rollbackAll(sessionId: string): Promise<Result<void>> {
    const list = this.effectsBySession.get(sessionId);
    if (!list) return ok(undefined);
    for (let i = list.length - 1; i >= 0; i--) {
      await list[i].rollback();
    }
    this.effectsBySession.delete(sessionId);
    return ok(undefined);
  }

  async rollbackOne(effectId: string): Promise<Result<void>> {
    const effect = this.effectById.get(effectId);
    if (!effect) return err(`Effect ${effectId} not found`);
    await effect.rollback();
    this.effectById.delete(effectId);
    return ok(undefined);
  }
}

// ── 内存 CarrierManager ──────────────────────────────────────────

class InMemoryCarrierManager implements CarrierManager {
  private handles = new Map<string, PluginHandle>();
  private pluginsByName = new Map<string, LayerPlugin>();
  private counter = 0;

  async launch(
    plugin: LayerPlugin,
    carrier: CarrierKind,
  ): Promise<Result<PluginHandle>> {
    // 原型模式 = 全进程内插件：Thread 与 Subprocess 均内联执行；
    // Daemon / NetworkService 为生产专用载体，原型模式不支持。
    if (carrier !== CarrierKind.Thread && carrier !== CarrierKind.Subprocess) {
      return err(
        `原型模式不支持载体 ${carrier}，仅支持 ${CarrierKind.Thread}/${CarrierKind.Subprocess}（内联）`,
      );
    }
    const id = `handle-${++this.counter}`;
    const handle: PluginHandle = {
      id,
      name: plugin.manifest.name,
      layer: plugin.manifest.layer,
      carrier,
      state: PluginState.Active,
    };
    this.handles.set(id, handle);
    this.pluginsByName.set(plugin.manifest.name, plugin);
    return ok(handle);
  }

  async stop(handle: PluginHandle): Promise<Result<void>> {
    const h = this.handles.get(handle.id);
    if (!h) return err(`Handle ${handle.id} not found`);
    h.state = PluginState.Disposed;
    this.handles.delete(handle.id);
    return ok(undefined);
  }

  async migrate(
    handle: PluginHandle,
    _toCarrier: CarrierKind,
  ): Promise<Result<PluginHandle>> {
    return err("原型模式不支持运行时载体迁移");
  }

  async health(handle: PluginHandle): Promise<HealthStatus> {
    const plugin = this.pluginsByName.get(handle.name);
    if (!plugin) {
      return { healthy: false, detail: "plugin not found", checkedAt: new Date().toISOString() };
    }
    const providers = plugin.getProviders();
    for (const p of providers) {
      const h = await p.health();
      if (!h.healthy) return h;
    }
    return { healthy: true, detail: "all providers healthy", checkedAt: new Date().toISOString() };
  }

  list(): PluginHandle[] {
    return [...this.handles.values()];
  }
}

// ── 内存 KernelAdapter ───────────────────────────────────────────

export class InMemoryKernelAdapter implements KernelAdapter {
  readonly info: KernelInfo = {
    name: "in-memory",
    version: "0.1.0",
    supportedCarriers: [CarrierKind.Thread],
  };
  readonly registry = new InMemorySeamRegistry();
  readonly carriers = new InMemoryCarrierManager();
  readonly events = new InMemoryEventBus();
  readonly effects = new InMemoryEffectManager();

  private mode: RunMode = RunMode.Prototype;
  private ready = false;
  private sessionState = new Map<string, Map<string, unknown>>();
  private seq = 0;

  getMode(): RunMode {
    return this.mode;
  }

  createContext(sessionId: string, callerLayer: LayerId): SeamContext {
    const state = this.sessionState.get(sessionId) ?? new Map();
    this.sessionState.set(sessionId, state);

    return {
      sessionId,
      traceId: `trace-${sessionId}`,
      callerLayer,
      addEffect: (description: string, rollback: () => Promise<void>): string => {
        // 同步占位：返回同步占位 id 以满足 SeamContext 契约；
        // effect 由 EffectManager 异步分配并记录。
        const id = `ctx-effect-${++this.seq}`;
        void this.effects.record(sessionId, description, rollback).catch((e: unknown) => {
          void this.events.publish({
            seq: ++this.seq,
            timestamp: new Date().toISOString(),
            type: "effect.record-failed",
            layer: callerLayer,
            payload: { description, error: String(e) },
            traceId: `trace-${sessionId}`,
          });
        });
        return id;
      },
      emit: (event: Omit<SystemEvent, "seq" | "timestamp">): void => {
        const full: SystemEvent = {
          ...event,
          seq: ++this.seq,
          timestamp: new Date().toISOString(),
        };
        void this.events.publish(full);
      },
      getState: <T>(key: string): T | undefined => {
        return state.get(key) as T | undefined;
      },
      setState: <T>(key: string, value: T): void => {
        state.set(key, value);
      },
    };
  }

  async init(config: KernelConfig): Promise<Result<void>> {
    this.mode = config.mode;
    this.ready = true;
    return ok(undefined);
  }

  async shutdown(): Promise<Result<void>> {
    this.ready = false;
    return ok(undefined);
  }

  isReady(): boolean {
    return this.ready;
  }
}
