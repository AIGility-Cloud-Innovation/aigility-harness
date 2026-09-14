import { describe, it, expect, vi } from "vitest";
import {
  ok,
  err,
  LayerId,
  LAYER_ORDER,
  CarrierKind,
  RunMode,
  PluginState,
  InProcessScheduler,
  LAYER_DESCRIPTORS,
  bootstrap,
  shutdown,
} from "./index.js";
import type { KernelAdapter, KernelConfig } from "./kernel-adapter.js";
import type { SeamRegistry, SeamContext } from "./seam.js";
import type { LayerPlugin, PluginManifest } from "./layer-plugin.js";

// ── Result helpers ────────────────────────────────────────────────

describe("Result helpers", () => {
  it("ok() carries a value", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("err() carries an error", () => {
    const r = err("boom");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("boom");
  });
});

// ── Layer ordering ────────────────────────────────────────────────

describe("Layer ordering", () => {
  it("LAYER_ORDER lists all five layers", () => {
    expect(LAYER_ORDER).toEqual([
      LayerId.Infrastructure,
      LayerId.Cognitive,
      LayerId.Persona,
      LayerId.Orchestration,
      LayerId.Action,
    ]);
  });

  it("LAYER_DESCRIPTORS knows dependency order", () => {
    const infra = LAYER_DESCRIPTORS[LayerId.Infrastructure];
    expect(infra.dependsOn).toEqual([]);
    expect(infra.alwaysOn).toBe(true);
  });
});

// ── InProcessScheduler ────────────────────────────────────────────

describe("InProcessScheduler", () => {
  const stubAdapter = (): KernelAdapter => {
    const carriers = {
      list: () => [],
      launch: async () => ok({ id: "x", name: "x", layer: LayerId.Cognitive, carrier: CarrierKind.Thread, state: PluginState.Active }),
      stop: async () => ok(undefined),
      migrate: async () => ok({ id: "x", name: "x", layer: LayerId.Cognitive, carrier: CarrierKind.Thread, state: PluginState.Active }),
      health: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
    };
    const registry: SeamRegistry = {
      register: async () => ok(undefined),
      unregister: async () => ok(undefined),
      resolve: async () => ok({} as never),
      rebind: async () => ok(undefined),
      listProviders: () => [],
      listAllServices: () => [],
      onEvent: () => () => {},
    };
    return {
      info: { name: "stub", version: "0.0.1", supportedCarriers: [CarrierKind.Thread] },
      registry,
      carriers,
      events: {
        publish: async () => {},
        subscribe: () => () => {},
        replay: async function* () {},
      },
      effects: {
        record: async () => "effect-1",
        rollbackAll: async () => ok(undefined),
        rollbackOne: async () => ok(undefined),
      },
      getMode: () => RunMode.Prototype,
      createContext: (sessionId: string, callerLayer: LayerId): SeamContext => ({
        sessionId,
        traceId: "trace-1",
        callerLayer,
        addEffect: () => "effect-1",
        emit: () => {},
        getState: () => undefined,
        setState: () => {},
        call: async () => err("no provider in test stub"),
      }),
      init: async () => ok(undefined),
      shutdown: async () => ok(undefined),
      isReady: () => true,
    };
  };

  it("starts and stops cleanly", () => {
    const scheduler = new InProcessScheduler(stubAdapter(), stubAdapter().registry);
    scheduler.start();
    scheduler.stop();
    expect(true).toBe(true);
  });

  it("checkNow returns decisions (noop on empty)", async () => {
    const scheduler = new InProcessScheduler(stubAdapter(), stubAdapter().registry);
    const decisions = await scheduler.checkNow();
    expect(Array.isArray(decisions)).toBe(true);
  });
});

// ── Scheduler rebind 闭环 (P1: 决策真实执行) ──────────────────────

import { ok as _ok, err as _err } from "./index.js";
import type { Provider, ServiceDefinition, CapabilityRef, SeamRegistry, SeamRegistryEvent } from "./seam.js";
import type { SystemEvent, HealthStatus } from "./types.js";

function makeFakeRegistry() {
  const services = new Map<string, ServiceDefinition>();
  const providers = new Map<string, Provider[]>();
  const preferred = new Map<string, string>();
  const reboundEvents: SeamRegistryEvent[] = [];
  const registry: SeamRegistry & { _providers: Map<string, Provider[]> } = {
    _providers: providers,
    register: async (service, provider) => {
      services.set(service.id, service);
      const list = providers.get(service.id) ?? [];
      list.push(provider);
      providers.set(service.id, list);
      return _ok(undefined);
    },
    unregister: async () => _ok(undefined),
    resolve: async (ref: CapabilityRef) => {
      const list = providers.get(ref.id) ?? [];
      const pinned = preferred.get(ref.id);
      const hit = (pinned && list.find((p) => p.name === pinned)) || list[0];
      return hit ? _ok(hit) : _err(`no provider for ${ref.id}`);
    },
    rebind: async (ref: CapabilityRef, name: string | null) => {
      const list = providers.get(ref.id) ?? [];
      const from = preferred.get(ref.id) ?? list[0]?.name ?? "";
      if (name === null) preferred.delete(ref.id);
      else {
        if (!list.some((p) => p.name === name)) return _err(`unknown provider ${name}`);
        preferred.set(ref.id, name);
      }
      const to = name ?? list[0]?.name ?? "";
      reboundEvents.push({ type: "rebound", ref: { ...ref }, fromProvider: from, toProvider: to });
      return _ok(undefined);
    },
    listProviders: (id: string) => providers.get(id) ?? [],
    listAllServices: () =>
      [...services.values()].map((service) => ({
        service,
        providerName: (providers.get(service.id) ?? [])[0]?.name ?? "",
        state: PluginState.Active,
      })),
    onEvent: () => () => {},
  };
  return { registry, reboundEvents, preferred };
}

function makeFakeAdapter(published: SystemEvent[]): KernelAdapter {
  return {
    carriers: { list: () => [], launch: async () => _ok({} as never), stop: async () => _ok(undefined), migrate: async () => _ok({} as never), health: async () => ({ healthy: true, checkedAt: "" }) },
    events: { publish: async (e: SystemEvent) => { published.push(e); }, subscribe: () => () => {}, replay: async function* () {} },
    effects: { record: async () => "e", rollbackAll: async () => _ok(undefined), rollbackOne: async () => _ok(undefined) },
    registry: null as never,
    info: { name: "fake", version: "0", supportedCarriers: [] },
    getMode: () => RunMode.Prototype,
    createContext: (() => ({})) as never,
    init: async () => _ok(undefined),
    shutdown: async () => _ok(undefined),
    isReady: () => true,
  } as unknown as KernelAdapter;
}

describe("InProcessScheduler rebind 闭环", () => {
  const SERVICE: ServiceDefinition = { id: "@cog/llm", version: "1.0.0", layer: LayerId.Cognitive, description: "t" };
  const healthOf: Record<string, boolean> = {};
  const mkProvider = (name: string): Provider => ({
    service: SERVICE,
    name,
    state: PluginState.Active,
    execute: async () => _ok({} as never),
    health: async () => ({ healthy: healthOf[name] ?? true, checkedAt: new Date().toISOString() }),
  });

  function setup(): ReturnType<typeof makeFakeRegistry> & { scheduler: InProcessScheduler; published: SystemEvent[] } {
    healthOf["p-head"] = true;
    healthOf["p-sib"] = true;
    const { registry, reboundEvents, preferred } = makeFakeRegistry();
    const published: SystemEvent[] = [];
    const adapter = makeFakeAdapter(published);
    (adapter as unknown as { registry: SeamRegistry }).registry = registry;
    const scheduler = new InProcessScheduler(adapter, registry);
    scheduler.setPolicy({ failureThreshold: 2, intervalMs: 3_600_000 });
    return { registry, reboundEvents, preferred, scheduler, published };
  }

  it("绑定 provider 连续失败达阈值 → rebind 决策, apply 后 resolve 切到健康同级", async () => {
    const t = setup();
    await t.registry.register(SERVICE, mkProvider("p-head"));
    await t.registry.register(SERVICE, mkProvider("p-sib"));

    healthOf["p-head"] = false;
    const d1 = await t.scheduler.checkNow();
    expect(d1).toHaveLength(0); // 失败 1 次 < 阈值 2
    const d2 = await t.scheduler.checkNow();
    expect(d2).toHaveLength(1);
    expect(d2[0]).toMatchObject({ type: "rebind", from: "p-head", to: "p-sib" });

    // 决策未应用前绑定不变
    const r0 = await t.registry.resolve({ id: SERVICE.id, versionRange: "^1.0.0" });
    expect(r0.ok && r0.value.name).toBe("p-head");

    await t.scheduler.apply(d2);
    const r = await t.registry.resolve({ id: SERVICE.id, versionRange: "^1.0.0" });
    expect(r.ok && r.value.name).toBe("p-sib");
    expect(t.reboundEvents.some((e) => e.type === "rebound" && e.toProvider === "p-sib")).toBe(true);
    expect(t.published.some((e) => e.type === "scheduler.rebind")).toBe(true);
  });

  it("默认绑定恢复健康达阈值 → failback 回默认绑定", async () => {
    const t = setup();
    await t.registry.register(SERVICE, mkProvider("p-head"));
    await t.registry.register(SERVICE, mkProvider("p-sib"));

    healthOf["p-head"] = false;
    await t.scheduler.checkNow();
    const d = await t.scheduler.checkNow();
    await t.scheduler.apply(d);
    const r1 = await t.registry.resolve({ id: SERVICE.id, versionRange: "^1.0.0" });
    expect(r1.ok && r1.value.name).toBe("p-sib");

    // 恢复: 默认绑定连续健康 2 轮 → failback
    healthOf["p-head"] = true;
    await t.scheduler.checkNow();
    const d2 = await t.scheduler.checkNow();
    const failback = d2.find((x) => x.type === "rebind");
    expect(failback).toMatchObject({ from: "p-sib", to: "p-head" });
    await t.scheduler.apply([failback!]);
    const r2 = await t.registry.resolve({ id: SERVICE.id, versionRange: "^1.0.0" });
    expect(r2.ok && r2.value.name).toBe("p-head");
  });

  it("无健康同级 → 仅告警, 绑定不变", async () => {
    const t = setup();
    await t.registry.register(SERVICE, mkProvider("p-head"));
    healthOf["p-head"] = false;
    await t.scheduler.checkNow();
    const d = await t.scheduler.checkNow();
    expect(d).toHaveLength(1);
    expect(d[0]!.type).toBe("alert");
    await t.scheduler.apply(d);
    const r = await t.registry.resolve({ id: SERVICE.id, versionRange: "^1.0.0" });
    expect(r.ok && r.value.name).toBe("p-head");
    expect(t.published.some((e) => e.type === "scheduler.alert")).toBe(true);
  });
});

// ── Bootstrap with a minimal in-memory plugin ─────────────────────

describe("bootstrap", () => {
  const makePlugin = (name: string, layer: LayerId): LayerPlugin => {
    const manifest: PluginManifest = {
      name,
      layer,
      description: `test plugin ${name}`,
      version: "0.1.0",
      provides: [],
      consumes: [],
      preferredCarrier: CarrierKind.Thread,
    };
    return {
      manifest,
      onLoad: async () => ok(undefined),
      getProviders: () => [],
      getState: () => PluginState.Active,
    };
  };

  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "test",
    autoHotSwap: false,
    healthCheckIntervalMs: 5_000,
  };

  const stubAdapter = (): KernelAdapter => {
    const carriers = {
      list: () => [],
      launch: async () => ok({ id: "x", name: "x", layer: LayerId.Cognitive, carrier: CarrierKind.Thread, state: PluginState.Active }),
      stop: async () => ok(undefined),
      migrate: async () => ok({ id: "x", name: "x", layer: LayerId.Cognitive, carrier: CarrierKind.Thread, state: PluginState.Active }),
      health: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
    };
    const registry: SeamRegistry = {
      register: async () => ok(undefined),
      unregister: async () => ok(undefined),
      resolve: async () => ok({} as never),
      rebind: async () => ok(undefined),
      listProviders: () => [],
      listAllServices: () => [],
      onEvent: () => () => {},
    };
    return {
      info: { name: "stub", version: "0.0.1", supportedCarriers: [CarrierKind.Thread] },
      registry,
      carriers,
      events: {
        publish: async () => {},
        subscribe: () => () => {},
        replay: async function* () {},
      },
      effects: {
        record: async () => "effect-1",
        rollbackAll: async () => ok(undefined),
        rollbackOne: async () => ok(undefined),
      },
      getMode: () => RunMode.Prototype,
      createContext: (sessionId: string, callerLayer: LayerId): SeamContext => ({
        sessionId,
        traceId: "trace-1",
        callerLayer,
        addEffect: () => "effect-1",
        emit: () => {},
        getState: () => undefined,
        setState: () => {},
        call: async () => err("no provider in test stub"),
      }),
      init: async () => ok(undefined),
      shutdown: async () => ok(undefined),
      isReady: () => true,
    };
  };

  it("boots with plugins and shuts down", async () => {
    const adapter = stubAdapter();
    const initSpy = vi.spyOn(adapter, "init");
    const plugins = [
      makePlugin("test-infra", LayerId.Infrastructure),
      makePlugin("test-cognitive", LayerId.Cognitive),
    ];
    const result = await bootstrap({ kernel: adapter, kernelConfig, plugins });
    expect(result.ok).toBe(true);
    expect(initSpy).toHaveBeenCalled();

    const sd = await shutdown(adapter);
    expect(sd.ok).toBe(true);
  });

  it("fails fast when kernel init fails", async () => {
    const adapter = stubAdapter();
    vi.spyOn(adapter, "init").mockResolvedValue(err("kernel down"));
    const result = await bootstrap({
      kernel: adapter,
      kernelConfig,
      plugins: [],
    });
    expect(result.ok).toBe(false);
  });
});