/**
 * RemoteEventBus + BusBridge 单测 (阶段 2: 跨进程事件桥)
 *
 * 验证:
 *   1. memory 桥: 连接/发布/订阅/退订
 *   2. 跨进程互通: 节点 A 发布 → 节点 B 订阅者收到
 *   3. 回环保护: 节点收到自己的信封被丢弃
 *   4. layer 隔离: 订阅 L1 收不到 L2 事件
 *   5. 信封协议: BUS_PROTOCOL / sourceNode / topic
 */
import { describe, it, expect } from "vitest";
import {
  BUS_PROTOCOL,
  createBusBridge,
  eventTopic,
  LayerId,
  ok,
} from "@aigility-harness/core";
import type { BusEnvelope, EventBus, SystemEvent } from "@aigility-harness/core";
import { RemoteEventBus, demoEvent, bridgeEventBus } from "./remote-event-bus.js";

/** 内存版本地 EventBus (进程内订阅/发布) */
class MemoryLocalBus implements EventBus {
  private handlers = new Map<LayerId, Set<(e: SystemEvent) => void>>();
  private seq = 0;

  async publish(event: SystemEvent): Promise<void> {
    this.seq++;
    const handlers = this.handlers.get(event.layer);
    handlers?.forEach((h) => h({ ...event, seq: this.seq }));
  }

  subscribe(layer: LayerId, cb: (e: SystemEvent) => void): () => void {
    const set = this.handlers.get(layer) ?? new Set();
    set.add(cb);
    this.handlers.set(layer, set);
    return () => set.delete(cb);
  }

  async *replay(_fromSeq: number): AsyncIterable<SystemEvent> {
    yield* [];
  }
}

describe("BusBridge memory 实现", () => {
  it("连接后发布/订阅/退订工作正常", async () => {
    const a = createBusBridge("memory", { nodeId: "node-a" });
    await a.connect();

    const got: BusEnvelope[] = [];
    const unsubRes = await a.subscribe("t", (env) => got.push(env));
    expect(unsubRes.ok).toBe(true);

    const env: BusEnvelope = {
      protocol: BUS_PROTOCOL,
      sourceNode: "node-b",
      topic: "t",
      event: demoEvent(LayerId.Infrastructure, "test", { n: 1 }),
    };
    await a.publish(env);
    await new Promise((r) => setTimeout(r, 5));

    expect(got.length).toBe(1);
    expect(got[0].event.payload).toEqual({ n: 1 });

    // 退订后不再收到
    if (unsubRes.ok) unsubRes.value();
    await a.publish(env);
    await new Promise((r) => setTimeout(r, 5));
    expect(got.length).toBe(1);
  });

  it("未连接时 publish 返回 err", async () => {
    const b = createBusBridge("memory", { nodeId: "node-x" });
    const r = await b.publish({
      protocol: BUS_PROTOCOL,
      sourceNode: "node-x",
      topic: "t",
      event: demoEvent(LayerId.Infrastructure, "test", {}),
    });
    expect(r.ok).toBe(false);
  });

  it("不支持的总线 kind 抛出明确错误(预留)", () => {
    expect(() => createBusBridge("nats" as never, { nodeId: "n" })).toThrow(
      /not implemented yet/,
    );
  });

  it("remove 后枚举", () => {
    const e = eventTopic("infrastructure");
    expect(e).toContain("aigility.events.");
  });
});

describe("RemoteEventBus 跨进程桥", () => {
  it("节点 A 发布 → 节点 B 订阅者收到(跨节点互通)", async () => {
    const bridgeA = createBusBridge("memory", { nodeId: "node-a" });
    const bridgeB = createBusBridge("memory", { nodeId: "node-b" });
    await bridgeA.connect();
    await bridgeB.connect();

    const busA = new RemoteEventBus(new MemoryLocalBus(), bridgeA);
    const busB = new RemoteEventBus(new MemoryLocalBus(), bridgeB);

    const gotB: unknown[] = [];
    busB.subscribe(LayerId.Infrastructure, (e) => gotB.push(e));

    await busA.publish(
      demoEvent(LayerId.Infrastructure, "remote.test", { from: "A" }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(gotB.length).toBe(1);
    expect((gotB[0] as { payload?: unknown }).payload).toEqual({ from: "A" });
  });

  it("回环保护: 节点不会收到自己发布的事件", async () => {
    const bridgeA = createBusBridge("memory", { nodeId: "node-a" });
    const bridgeB = createBusBridge("memory", { nodeId: "node-b" });
    await bridgeA.connect();
    await bridgeB.connect();

    const busA = new RemoteEventBus(new MemoryLocalBus(), bridgeA);
    const busB = new RemoteEventBus(new MemoryLocalBus(), bridgeB);

    const gotA: unknown[] = [];
    // A 本地也订阅(同节点) — 本地应收到, 远端桥回环应被丢弃
    busA.subscribe(LayerId.Infrastructure, (e) => gotA.push(e));

    await busA.publish(
      demoEvent(LayerId.Infrastructure, "loop.test", { from: "A" }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // A 只收本地 1 条(桥不会给自己回发)
    const payloads = gotA.map((e) => (e as { payload?: unknown }).payload);
    const remoteOnes = payloads.filter(
      (p) => (p as { via?: string })?.via === "bridge",
    );
    expect(payloads.length).toBe(1);
    expect(remoteOnes.length).toBe(0);
  });

  it("layer 隔离: 订阅 L1 收不到 L2 远端事件", async () => {
    const bridgeA = createBusBridge("memory", { nodeId: "node-a" });
    const bridgeB = createBusBridge("memory", { nodeId: "node-b" });
    await bridgeA.connect();
    await bridgeB.connect();

    const busA = new RemoteEventBus(new MemoryLocalBus(), bridgeA);
    const busB = new RemoteEventBus(new MemoryLocalBus(), bridgeB);

    const gotL1: unknown[] = [];
    const gotL2: unknown[] = [];
    busB.subscribe(LayerId.Cognitive, (e) => gotL1.push(e));
    busB.subscribe(LayerId.Orchestration, (e) => gotL2.push(e));

    await busA.publish(
      demoEvent(LayerId.Orchestration, "l2.event", { x: 1 }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(gotL1.length).toBe(0);
    expect(gotL2.length).toBe(1);
  });

  it("bridgeEventBus 便捷装配: remote 可当原 EventBus 用", async () => {
    const bridge = createBusBridge("memory", { nodeId: "node-main" });
    await bridge.connect();
    const { remote } = bridgeEventBus(new MemoryLocalBus(), bridge);

    // remote 实现了完整 EventBus 接口, 可直接替换使用
    expect(typeof remote.publish).toBe("function");
    expect(typeof remote.subscribe).toBe("function");
    expect(typeof remote.replay).toBe("function");
    expect(remote).toBeInstanceOf(RemoteEventBus);
  });
});

// 防止 ok 未使用告警(用于类型引用场景)
void ok;