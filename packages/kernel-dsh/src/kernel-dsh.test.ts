import { describe, it, expect } from "vitest";
import { Context } from "@cordisjs/core";
import {
  CarrierKind,
  LayerId,
  PluginState,
  RunMode,
  ok,
  err,
} from "@aigility-arch/core";
import type {
  KernelConfig,
  LayerPlugin,
  PluginManifest,
  Provider,
  ServiceDefinition,
  SeamContext,
  SeamRegistry,
} from "@aigility-arch/core";
import {
  DshKernelAdapter,
  CordisSeamRegistry,
  CordisEventBus,
  InMemoryEffectManager,
  DshCarrierManager,
  EffectStore,
  satisfies,
} from "./index.js";

// ── helpers ──────────────────────────────────────────────────────

const makeService = (
  id: string,
  version: string,
  layer: LayerId = LayerId.Cognitive,
): ServiceDefinition => ({
  id,
  version,
  layer,
  description: `service ${id}`,
});

const makeProvider = (
  service: ServiceDefinition,
  name: string,
  state: PluginState = PluginState.Active,
): Provider => ({
  service,
  name,
  state,
  execute: async () => ok({ ok: true } as never),
  health: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
});

const makePlugin = (
  name: string,
  layer: LayerId,
  state: PluginState = PluginState.Active,
): LayerPlugin => {
  const manifest: PluginManifest = {
    name,
    layer,
    description: `test ${name}`,
    version: "0.1.0",
    provides: [],
    consumes: [],
    preferredCarrier: CarrierKind.Thread,
  };
  let s = state;
  return {
    manifest,
    onLoad: async () => {
      s = PluginState.Active;
      return ok(undefined);
    },
    onUnload: async () => {
      s = PluginState.Disposed;
      return ok(undefined);
    },
    getProviders: () => [],
    getState: () => s,
  };
};

const kernelConfig: KernelConfig = {
  mode: RunMode.Prototype,
  profile: "test",
  autoHotSwap: false,
  healthCheckIntervalMs: 5_000,
};

// ── semver ───────────────────────────────────────────────────────

describe("satisfies", () => {
  it("exact match", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });

  it("caret range", () => {
    expect(satisfies("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfies("1.9.0", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
  });

  it("tilde range", () => {
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
  });

  it("wildcard", () => {
    expect(satisfies("3.4.5", "*")).toBe(true);
  });

  it("strips prerelease tags", () => {
    expect(satisfies("1.0.0-beta.5", "^1.0.0")).toBe(true);
  });
});

// ── CordisSeamRegistry ───────────────────────────────────────────

describe("CordisSeamRegistry", () => {
  it("registers and resolves a provider", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const service = makeService("@cog/llm", "1.0.0");
    const provider = makeProvider(service, "llm-openai");

    const r = await registry.register(service, provider);
    expect(r.ok).toBe(true);

    const resolved = await registry.resolve({ id: "@cog/llm", versionRange: "^1.0.0" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.name).toBe("llm-openai");
  });

  it("picks the highest satisfying version", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const s1 = makeService("@cog/x", "1.0.0");
    const s2 = makeService("@cog/x", "1.2.0");
    await registry.register(s1, makeProvider(s1, "x-old"));
    await registry.register(s2, makeProvider(s2, "x-new"));

    const resolved = await registry.resolve({ id: "@cog/x", versionRange: "^1.0.0" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.name).toBe("x-new");
  });

  it("unregisters a provider", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const service = makeService("@cog/y", "1.0.0");
    await registry.register(service, makeProvider(service, "y-impl"));

    const r = await registry.unregister("y-impl");
    expect(r.ok).toBe(true);
    expect(registry.listProviders("@cog/y")).toHaveLength(0);
  });

  it("emits registry events", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const events: string[] = [];
    registry.onEvent((e) => events.push(e.type));

    const service = makeService("@cog/z", "1.0.0");
    await registry.register(service, makeProvider(service, "z-impl"));
    await registry.unregister("z-impl");
    expect(events).toEqual(["registered", "unregistered"]);
  });

  it("rejects duplicate provider names", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const service = makeService("@cog/d", "1.0.0");
    await registry.register(service, makeProvider(service, "d-impl"));
    const r = await registry.register(service, makeProvider(service, "d-impl"));
    expect(r.ok).toBe(false);
  });

  it("resolve fails when no provider satisfies", async () => {
    const ctx = new Context();
    const registry = new CordisSeamRegistry(ctx);
    const resolved = await registry.resolve({ id: "@none/x", versionRange: "^1.0.0" });
    expect(resolved.ok).toBe(false);
  });
});

// ── CordisEventBus ───────────────────────────────────────────────

describe("CordisEventBus", () => {
  it("publishes and subscribes layer-scoped events", async () => {
    const ctx = new Context();
    const bus = new CordisEventBus(ctx);
    const received: unknown[] = [];
    bus.subscribe(LayerId.Cognitive, (e) => received.push(e));

    await bus.publish({
      seq: 0,
      timestamp: new Date().toISOString(),
      type: "test.event",
      layer: LayerId.Cognitive,
      payload: { hello: "world" },
    });
    expect(received).toHaveLength(1);
  });

  it("does not deliver events to other layers", async () => {
    const ctx = new Context();
    const bus = new CordisEventBus(ctx);
    const received: unknown[] = [];
    bus.subscribe(LayerId.Action, (e) => received.push(e));

    await bus.publish({
      seq: 0,
      timestamp: new Date().toISOString(),
      type: "test.event",
      layer: LayerId.Cognitive,
      payload: null,
    });
    expect(received).toHaveLength(0);
  });

  it("replays events from a sequence number", async () => {
    const ctx = new Context();
    const bus = new CordisEventBus(ctx);
    for (let i = 1; i <= 3; i++) {
      await bus.publish({
        seq: i,
        timestamp: new Date().toISOString(),
        type: "t",
        layer: LayerId.Cognitive,
        payload: i,
      });
    }
    const out: number[] = [];
    for await (const e of bus.replay(2)) {
      out.push(e.payload as number);
    }
    expect(out).toEqual([2, 3]);
  });

  it("unsubscribe stops delivery", async () => {
    const ctx = new Context();
    const bus = new CordisEventBus(ctx);
    const received: unknown[] = [];
    const off = bus.subscribe(LayerId.Cognitive, (e) => received.push(e));
    off();
    await bus.publish({
      seq: 0,
      timestamp: new Date().toISOString(),
      type: "t",
      layer: LayerId.Cognitive,
      payload: null,
    });
    expect(received).toHaveLength(0);
  });
});

// ── InMemoryEffectManager ────────────────────────────────────────

describe("InMemoryEffectManager", () => {
  it("records and rolls back a single effect", async () => {
    const store = new EffectStore();
    const mgr = new InMemoryEffectManager(store);
    let rolled = false;
    const id = await mgr.record("s1", "do thing", async () => {
      rolled = true;
    });
    const r = await mgr.rollbackOne(id);
    expect(r.ok).toBe(true);
    expect(rolled).toBe(true);
  });

  it("rollbackAll runs in reverse order", async () => {
    const store = new EffectStore();
    const mgr = new InMemoryEffectManager(store);
    const order: string[] = [];
    await mgr.record("s1", "first", async () => order.push("first"));
    await mgr.record("s1", "second", async () => order.push("second"));
    await mgr.record("s1", "third", async () => order.push("third"));

    const r = await mgr.rollbackAll("s1");
    expect(r.ok).toBe(true);
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("rollbackOne on unknown id fails", async () => {
    const store = new EffectStore();
    const mgr = new InMemoryEffectManager(store);
    const r = await mgr.rollbackOne("nope");
    expect(r.ok).toBe(false);
  });

  it("rollbackAll on empty session is ok", async () => {
    const store = new EffectStore();
    const mgr = new InMemoryEffectManager(store);
    const r = await mgr.rollbackAll("empty");
    expect(r.ok).toBe(true);
  });
});

// ── DshCarrierManager ───────────────────────────────────────────

describe("DshCarrierManager", () => {
  const stubCtx = (): SeamContext => ({
    sessionId: "s",
    traceId: "t",
    callerLayer: LayerId.Cognitive,
    addEffect: () => "e",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
  });

  it("launches a Thread plugin", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const plugin = makePlugin("p1", LayerId.Cognitive);
    const r = await mgr.launch(plugin, CarrierKind.Thread);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe(PluginState.Active);
  });

  it("launches a Subprocess plugin", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const r = await mgr.launch(makePlugin("p2", LayerId.Action), CarrierKind.Subprocess);
    expect(r.ok).toBe(true);
  });

  it("rejects Daemon in prototype mode", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const r = await mgr.launch(makePlugin("p3", LayerId.Cognitive), CarrierKind.Daemon);
    expect(r.ok).toBe(false);
  });

  it("rejects NetworkService in prototype mode", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const r = await mgr.launch(
      makePlugin("p4", LayerId.Cognitive),
      CarrierKind.NetworkService,
    );
    expect(r.ok).toBe(false);
  });

  it("stops a launched plugin", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const launch = await mgr.launch(makePlugin("p5", LayerId.Cognitive), CarrierKind.Thread);
    if (!launch.ok) throw new Error("launch failed");
    const r = await mgr.stop(launch.value);
    expect(r.ok).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });

  it("migrates between Thread and Subprocess", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const launch = await mgr.launch(makePlugin("p6", LayerId.Cognitive), CarrierKind.Thread);
    if (!launch.ok) throw new Error("launch failed");
    const r = await mgr.migrate(launch.value, CarrierKind.Subprocess);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.carrier).toBe(CarrierKind.Subprocess);
  });

  it("health reports active for running plugin", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    const launch = await mgr.launch(makePlugin("p7", LayerId.Cognitive), CarrierKind.Thread);
    if (!launch.ok) throw new Error("launch failed");
    const h = await mgr.health(launch.value);
    expect(h.healthy).toBe(true);
  });

  it("list returns all handles", async () => {
    const mgr = new DshCarrierManager(() => stubCtx());
    await mgr.launch(makePlugin("a", LayerId.Cognitive), CarrierKind.Thread);
    await mgr.launch(makePlugin("b", LayerId.Perception), CarrierKind.Subprocess);
    expect(mgr.list()).toHaveLength(2);
  });
});

// ── DshKernelAdapter ─────────────────────────────────────────────

describe("DshKernelAdapter", () => {
  it("exposes kernel info", () => {
    const a = new DshKernelAdapter();
    expect(a.info.name).toBe("dsh-cordis");
    expect(a.info.version).toBe("0.1.0");
    expect(a.info.supportedCarriers).toContain(CarrierKind.Thread);
  });

  it("init sets mode and ready", async () => {
    const a = new DshKernelAdapter();
    expect(a.isReady()).toBe(false);
    const r = await a.init(kernelConfig);
    expect(r.ok).toBe(true);
    expect(a.getMode()).toBe(RunMode.Prototype);
    expect(a.isReady()).toBe(true);
  });

  it("shutdown makes the kernel not ready", async () => {
    const a = new DshKernelAdapter();
    await a.init(kernelConfig);
    const r = await a.shutdown();
    expect(r.ok).toBe(true);
    expect(a.isReady()).toBe(false);
  });

  it("init after shutdown fails", async () => {
    const a = new DshKernelAdapter();
    await a.init(kernelConfig);
    await a.shutdown();
    const r = await a.init(kernelConfig);
    expect(r.ok).toBe(false);
  });

  it("createContext returns a SeamContext", () => {
    const a = new DshKernelAdapter();
    const ctx = a.createContext("sess-1", LayerId.Cognitive);
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.callerLayer).toBe(LayerId.Cognitive);
    expect(ctx.traceId).toBe("trace-sess-1");
  });

  it("SeamContext addEffect/emit/getState/setState", async () => {
    const a = new DshKernelAdapter();
    await a.init(kernelConfig);
    const ctx = a.createContext("sess-2", LayerId.Action);

    ctx.setState("k", 42);
    expect(ctx.getState("k")).toBe(42);

    const id = ctx.addEffect("side", async () => {});
    expect(typeof id).toBe("string");

    ctx.emit({ type: "test", layer: LayerId.Action, payload: null });
    // emit is fire-and-forget; just ensure it doesn't throw
    expect(true).toBe(true);
  });

  it("carriers, registry, events, effects are wired", () => {
    const a = new DshKernelAdapter();
    expect(a.carriers).toBeDefined();
    expect(a.registry).toBeDefined();
    expect(a.events).toBeDefined();
    expect(a.effects).toBeDefined();
  });

  it("full lifecycle: init → launch → register → shutdown", async () => {
    const a = new DshKernelAdapter();
    await a.init(kernelConfig);

    const service = makeService("@cog/full", "1.0.0");
    const provider = makeProvider(service, "full-impl");
    const plugin: LayerPlugin = {
      manifest: {
        name: "full-plugin",
        layer: LayerId.Cognitive,
        description: "full",
        version: "0.1.0",
        provides: [service],
        consumes: [],
        preferredCarrier: CarrierKind.Thread,
      },
      onLoad: async () => ok(undefined),
      getProviders: () => [provider],
      getState: () => PluginState.Active,
    };

    const launch = await a.carriers.launch(plugin, CarrierKind.Thread);
    expect(launch.ok).toBe(true);

    const reg = await a.registry.register(service, provider);
    expect(reg.ok).toBe(true);

    const resolved = await a.registry.resolve({ id: "@cog/full", versionRange: "^1.0.0" });
    expect(resolved.ok).toBe(true);

    const sd = await a.shutdown();
    expect(sd.ok).toBe(true);
  });
});
