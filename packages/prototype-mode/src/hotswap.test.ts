/**
 * P1 调度闭环集成测试 — 真实内核 + 真实定时器 + bootstrap 装配
 *
 * 验证 autoHotSwap 全链路:
 *   bootstrap(autoHotSwap: true) → 调度器健康轮询 → 绑定 provider 连续失败
 *   → 自动 rebind 到健康同级 → 默认绑定恢复 → 自动 failback。
 * 绑定切换经 SeamRegistry.rebind 生效, 决策以 scheduler.* 事件发布到总线。
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootstrap, shutdown, InProcessScheduler, LayerId, CarrierKind, PluginState, ok } from "@aigility-harness/core";
import type {
  KernelConfig,
  ServiceDefinition,
  Provider,
  LayerPlugin,
  SystemEvent,
  Result,
} from "@aigility-harness/core";
import { InMemoryKernelAdapter } from "./in-memory-kernel.js";

const SERVICE: ServiceDefinition = {
  id: "@cog/llm",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "hotswap test service",
};

const healthOf: Record<string, boolean> = {};

function mkProvider(name: string): Provider {
  return {
    service: SERVICE,
    name,
    state: PluginState.Active,
    execute: async (): Promise<Result<unknown>> => ok({}),
    health: async () => ({
      healthy: healthOf[name] ?? true,
      checkedAt: new Date().toISOString(),
    }),
  };
}

function makePlugin(): LayerPlugin {
  return {
    manifest: {
      name: "@test/llm-host",
      layer: LayerId.Cognitive,
      description: "hosts two llm providers",
      version: "1.0.0",
      provides: [SERVICE],
      consumes: [],
      preferredCarrier: CarrierKind.Thread,
    },
    onLoad: async () => ok(undefined),
    getProviders: () => [mkProvider("p-head"), mkProvider("p-sib")],
    getState: () => PluginState.Active,
  };
}

/** 轮询直到断言通过或超时 (异步断言必须 await, 否则形同虚设) */
async function waitFor(expectFn: () => void | Promise<void>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await expectFn();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe("autoHotSwap 调度闭环 (真实定时器)", () => {
  const kernel = new InMemoryKernelAdapter();
  const kernelConfig: KernelConfig = {
    mode: "prototype" as never,
    profile: "test",
    autoHotSwap: true,
    healthCheckIntervalMs: 50,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const published: SystemEvent[] = [];
  let booted = false;

  afterEach(async () => {
    // 用例间复位: 绑定回默认, 健康全恢复, 清失败计数
    healthOf["p-head"] = true;
    healthOf["p-sib"] = true;
    await kernel.registry.rebind({ id: SERVICE.id, versionRange: "^1.0.0" }, null);
  });

  it("boots via bootstrap (autoHotSwap: true) 并完成故障转移 + 回切", async () => {
    kernel.events.subscribe(LayerId.Infrastructure, (e: SystemEvent) => {
      if (e.type.startsWith("scheduler.")) published.push(e);
    });

    const boot = await bootstrap({ kernel, kernelConfig, plugins: [makePlugin()], scheduler });
    expect(boot.ok).toBe(true);
    booted = true;

    const ref = { id: SERVICE.id, versionRange: "^1.0.0" };
    const r0 = await kernel.registry.resolve(ref);
    expect(r0.ok && r0.value.name).toBe("p-head"); // 默认绑定 = 插入序首个

    // 1) 默认绑定持续不健康 → 自动故障转移到健康同级
    healthOf["p-head"] = false;
    await waitFor(async () => {
      const r = await kernel.registry.resolve(ref);
      expect(r.ok && r.value.name).toBe("p-sib");
    });
    expect(published.some((e) => e.type === "scheduler.rebind")).toBe(true);

    // 2) 默认绑定恢复 → 自动回切
    healthOf["p-head"] = true;
    await waitFor(async () => {
      const r = await kernel.registry.resolve(ref);
      expect(r.ok && r.value.name).toBe("p-head");
    });
    expect(published.filter((e) => e.type === "scheduler.rebind").length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("进程就绪且可正常关停", async () => {
    expect(booted).toBe(true);
    expect(kernel.isReady()).toBe(true);
    scheduler.stop();
    const sd = await shutdown(kernel);
    expect(sd.ok).toBe(true);
  });
});
