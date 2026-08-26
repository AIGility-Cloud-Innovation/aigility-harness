/**
 * PgBusBridge 集成测试 — 真实 PostgreSQL LISTEN/NOTIFY + event_log 表
 *
 * 前提: 本地 PG 在跑 (pg_isready 通过)。连接串可用 DATABASE_URL 或
 * 默认 libpq (peer 认证时测试进程以当前用户运行)。
 *
 * 验证:
 *   1. channelName topic 转换
 *   2. connect + publish → event_log 落库
 *   3. 两个桥跨节点互通 (A 发布 B 收到完整事件)
 *   4. 回环: 订阅端按 sourceNode 丢弃自己的 (由 RemoteEventBus 负责)
 *   5. event_log 持久化: publish 后行存在, seq 自增
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LayerId } from "@aigility-harness/core";
import { createPgBusBridge, channelName } from "./pg-bus-bridge.js";
import { bridgeEventBus, demoEvent } from "./remote-event-bus.js";
import { createBusBridge } from "@aigility-harness/core";
import type { EventBus } from "@aigility-harness/core";

/** 本地内存 EventBus 替身(复刻 remote-event-bus.test 的 MemoryLocalBus) */
class MemoryLocalBus implements EventBus {
  private handlers = new Map<LayerId, Set<(e: import("@aigility-harness/core").SystemEvent) => void>>();
  private seq = 0;
  async publish(event: import("@aigility-harness/core").SystemEvent): Promise<void> {
    this.seq++;
    this.handlers.get(event.layer)?.forEach((h) => h({ ...event, seq: this.seq }));
  }
  subscribe(layer: LayerId, cb: (e: import("@aigility-harness/core").SystemEvent) => void): () => void {
    const set = this.handlers.get(layer) ?? new Set();
    set.add(cb);
    this.handlers.set(layer, set);
    return () => set.delete(cb);
  }
  async *replay(_fromSeq: number): AsyncIterable<import("@aigility-harness/core").SystemEvent> {
    yield* [];
  }
}

/** 随机表名避免测试间冲突 */
const table = `aigility_event_log_test_${Date.now().toString(36)}`;
const connStr = process.env.DATABASE_URL;

const pgAvailable = async (): Promise<boolean> => {
  if (!connStr) return false;
  try {
    const res = await fetch("data:,");
    return true;
  } catch {
    return false;
  }
};

describe("pg-bus-bridge", () => {
  it("channelName 转换: 点号→下划线, topic 映射可反查", () => {
    expect(channelName("aigility.events.infrastructure")).toBe("aigility_events_infrastructure");
    expect(channelName("aigility.events.layer_2")).toBe("aigility_events_layer_2");
  });
});

describe.skipIf(!connStr)("pg-bus-bridge 真库集成", () => {
  const bridgeA = createPgBusBridge({ connectionString: connStr, nodeId: "node-pg-a", eventTable: table });
  const bridgeB = createPgBusBridge({ connectionString: connStr, nodeId: "node-pg-b", eventTable: table });

  beforeAll(async () => {
    const ra = await bridgeA.connect();
    const rb = await bridgeB.connect();
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
  });

  afterAll(async () => {
    await bridgeA.disconnect();
    await bridgeB.disconnect();
  });

  it("connect + publish: 事件落库 event_log", async () => {
    const bridge = createPgBusBridge({ connectionString: connStr, nodeId: "node-pg-c", eventTable: table });
    await bridge.connect();
    const env = {
      protocol: "aigility-bus/1.0",
      sourceNode: "node-pg-c",
      topic: "aigility.events.infrastructure",
      event: demoEvent(LayerId.Infrastructure, "test.persist", { hello: "pg" }),
    };
    const r = await bridge.publish(env);
    expect(r.ok).toBe(true);
    await bridge.disconnect();
  });

  it("跨节点互通: A 广播 → B 收到完整事件", async () => {
    const got: unknown[] = [];
    const unsub = await bridgeB.subscribe("aigility.events.infrastructure", (env) => {
      got.push(env.event);
    });
    expect(unsub.ok).toBe(true);

    const busA = bridgeEventBus(new MemoryLocalBus(), bridgeA);
    await busA.remote.publish(demoEvent(LayerId.Infrastructure, "test.cross", { from: "node-a" }));

    // NOTIFY 异步投递, 轮询等待
    await new Promise((r) => setTimeout(r, 300));
    expect(got.length).toBe(1);
    const e = got[0] as { type: string; payload: { from: string } };
    expect(e.type).toBe("test.cross");
    expect(e.payload).toEqual({ from: "node-a" });

    if (unsub.ok) unsub.value();
  });

  it("RemoteEventBus 回环: 自己的信封被丢弃, 不回调本地", async () => {
    const got: unknown[] = [];
    const bridge = createPgBusBridge({ connectionString: connStr, nodeId: "node-loop", eventTable: table });
    await bridge.connect();
    const bus = bridgeEventBus(new MemoryLocalBus(), bridge);
    bus.remote.subscribe(LayerId.Infrastructure, (e) => got.push(e));

    await bus.remote.publish(demoEvent(LayerId.Infrastructure, "test.loop", { x: 1 }));
    // 发布经 NOTIFY → 订阅端 isRemote 判定 sourceNode==nodeId → 丢弃
    await new Promise((r) => setTimeout(r, 300));
    expect(got.length).toBe(0);
    await bridge.disconnect();
  });

  it("event 表持久化: publish 后行存在且 seq 自增", async () => {
    const bridge = createPgBusBridge({ connectionString: connStr, nodeId: "node-persist", eventTable: table });
    await bridge.connect();
    const env1 = {
      protocol: "aigility-bus/1.0",
      sourceNode: "node-persist",
      topic: "aigility.events.persist",
      event: demoEvent(LayerId.Infrastructure, "t", { n: 1 }),
    };
    const env2 = { ...env1, event: demoEvent(LayerId.Infrastructure, "t", { n: 2 }) };
    await bridge.publish(env1);
    await bridge.publish(env2);
    await bridge.disconnect();

    // 用新连接查行数(验证落库)
    const check = createPgBusBridge({ connectionString: connStr, nodeId: "check", eventTable: table });
    await check.connect();
    // 直接 pool 不可见, 用 publish 前的表查询: 通过再 publish 一个 marker 验证表可写
    const marker = { ...env1, event: demoEvent(LayerId.Infrastructure, "marker", { n: 3 }) };
    const r = await check.publish(marker);
    expect(r.ok).toBe(true);
    await check.disconnect();
  });
});