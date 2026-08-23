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
      LayerId.Cognitive,
      LayerId.Perception,
      LayerId.Orchestration,
      LayerId.Action,
      LayerId.Infrastructure,
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
      listProviders: () => [],
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
      listProviders: () => [],
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