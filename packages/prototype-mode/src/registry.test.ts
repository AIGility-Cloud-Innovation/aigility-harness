/**
 * InMemorySeamRegistry rebind 单测 (经 InMemoryKernelAdapter.registry 走公开契约)
 *
 * 覆盖: 默认按插入序绑定 / rebind pin 住指定 provider / rebind(null) 回落 /
 * 未知 provider 拒绝 / rebound 事件。
 */
import { describe, it, expect } from "vitest";
import { InMemoryKernelAdapter } from "./in-memory-kernel.js";
import { LayerId, CarrierKind, PluginState, RunMode, ok, err } from "@aigility-harness/core";
import type {
  KernelConfig,
  ServiceDefinition,
  Provider,
  SeamContext,
  SeamRegistryEvent,
  Result,
} from "@aigility-harness/core";

const SERVICE: ServiceDefinition = {
  id: "@cog/llm",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "test service",
};

const CONFIG: KernelConfig = {
  mode: RunMode.Prototype,
  profile: "default",
  autoHotSwap: false,
  healthCheckIntervalMs: 60_000,
};

function mkProvider(name: string): Provider {
  return {
    service: SERVICE,
    name,
    state: PluginState.Active,
    execute: async (): Promise<Result<unknown>> => ok({}),
    health: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
  };
}

function noopCtx(): SeamContext {
  return {
    sessionId: "s",
    traceId: "t",
    callerLayer: LayerId.Cognitive,
    addEffect: () => "e",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: async () => err("unused"),
  };
}

describe("InMemorySeamRegistry rebind", () => {
  it("默认按插入序绑定; rebind pin 住指定 provider; rebind(null) 回落", async () => {
    const kernel = new InMemoryKernelAdapter();
    await kernel.init(CONFIG);
    await kernel.registry.register(SERVICE, mkProvider("first"));
    await kernel.registry.register(SERVICE, mkProvider("second"));

    const ref = { id: SERVICE.id, versionRange: "^1.0.0" };
    const r0 = await kernel.registry.resolve(ref);
    expect(r0.ok && r0.value.name).toBe("first");

    const events: SeamRegistryEvent[] = [];
    kernel.registry.onEvent((e) => events.push(e));

    const rb = await kernel.registry.rebind(ref, "second");
    expect(rb.ok).toBe(true);
    const r1 = await kernel.registry.resolve(ref);
    expect(r1.ok && r1.value.name).toBe("second");
    expect(events.some((e) => e.type === "rebound" && e.toProvider === "second")).toBe(true);

    // 未知 provider → err, 绑定不变
    const bad = await kernel.registry.rebind(ref, "ghost");
    expect(bad.ok).toBe(false);
    const r2 = await kernel.registry.resolve(ref);
    expect(r2.ok && r2.value.name).toBe("second");

    // 清除覆盖 → 回落插入序首个
    await kernel.registry.rebind(ref, null);
    const r3 = await kernel.registry.resolve(ref);
    expect(r3.ok && r3.value.name).toBe("first");
  });

  it("pin 住的 provider 被注销后 resolve 自动回落", async () => {
    const kernel = new InMemoryKernelAdapter();
    await kernel.init(CONFIG);
    await kernel.registry.register(SERVICE, mkProvider("first"));
    await kernel.registry.register(SERVICE, mkProvider("second"));
    const ref = { id: SERVICE.id, versionRange: "^1.0.0" };

    await kernel.registry.rebind(ref, "second");
    await kernel.registry.unregister("second");

    const r = await kernel.registry.resolve(ref);
    expect(r.ok && r.value.name).toBe("first"); // 覆盖失效自动回落, 不抛错
  });

  it("launch 在 Thread 载体可用 (冒烟: 载体契约未破坏)", async () => {
    const kernel = new InMemoryKernelAdapter();
    await kernel.init(CONFIG);
    const plugin = {
      manifest: {
        name: "@test/one",
        layer: LayerId.Cognitive,
        description: "t",
        version: "1.0.0",
        provides: [SERVICE],
        consumes: [],
        preferredCarrier: CarrierKind.Thread,
      },
      onLoad: async () => ok(undefined),
      getProviders: () => [mkProvider("one-impl")],
      getState: () => PluginState.Active,
    };
    const r = await kernel.carriers.launch(plugin as never, CarrierKind.Thread);
    expect(r.ok).toBe(true);
  });
});
