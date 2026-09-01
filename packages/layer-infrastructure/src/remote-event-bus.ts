/**
 * L1 底座层: RemoteEventBus — 跨进程事件桥 (阶段 2)
 *
 * 把「进程内 EventBus」升级为「跨进程 EventBus」:
 *   - 本地发布: 事件同时发到本地订阅者(原逻辑不变) 与 BusBridge(广播给其他节点)
 *   - 本地订阅: 同时订阅本地(原逻辑不变) 与 BusBridge(接收远端事件)
 *   - 回环保护: 收到自己节点发出的信封丢弃
 *   - 按 layer 分 topic: 订阅者只收到自己 layer 的事件(与进程内行为一致)
 *
 * BusBridge 可更换: memory(原型/单测) / nats / redis / http(预留)。
 */

import {
  BUS_PROTOCOL,
  eventTopic,
  LayerId,
  ok,
} from "@aigility-harness/core";
import type {
  EventBus,
  BusBridge,
  BusEnvelope,
  SystemEvent,
  Result,
} from "@aigility-harness/core";

// ── 封装 ─────────────────────────────────────────────────────────

/** RemoteEventBus: 包装一个进程内 EventBus, 通过 BusBridge 跨进程互通 */
export class RemoteEventBus implements EventBus {
  private readonly bridgeSubs = new Map<
    string,
    Map<number, () => void>
  >();

  constructor(
    private readonly local: EventBus,
    private readonly bridge: BusBridge,
  ) {}

  // ── EventBus 契约 ──────────────────────────────────────────────

  async publish(event: SystemEvent): Promise<void> {
    // 1. 本地发布(原逻辑)
    await this.local.publish(event);

    // 2. 跨进程广播: 包装为信封发给其他节点
    const envelope: BusEnvelope = {
      protocol: BUS_PROTOCOL,
      sourceNode: this.bridge.nodeId,
      topic: eventTopic(event.layer),
      event,
    };
    await this.bridge.publish(envelope);
  }

  subscribe(
    layer: LayerId,
    callback: (event: SystemEvent) => void,
  ): () => void {
    // 1. 本地订阅(原逻辑)
    const unsubLocal = this.local.subscribe(layer, callback);

    // 2. 跨进程订阅: 接收远端事件, 回环保护后回调
    const topic = eventTopic(layer);
    const subId = this.nextSubId(topic);
    const unsubRemotePromise = this.bridge.subscribe(topic, (env) => {
      if (!isRemote(env, this.bridge.nodeId)) return; // 丢弃自己节点的
      callback(env.event);
    });

    // 用 bridge.subscribe 的退订函数
    void unsubRemotePromise.then((r) => {
      if (r.ok) {
        const map = this.bridgeSubs.get(topic) ?? new Map();
        map.set(subId, r.value);
        this.bridgeSubs.set(topic, map);
      }
    });

    return () => {
      unsubLocal();
      const map = this.bridgeSubs.get(topic);
      map?.get(subId)?.();
      map?.delete(subId);
    };
  }

  async *replay(fromSeq: number): AsyncIterable<SystemEvent> {
    // 事件回放仅包含本地节点记录(事件源语义: 每节点回放自己的日志)
    yield* this.local.replay(fromSeq);
  }

  // ── 辅助 ─────────────────────────────────────────────────────────

  private subCounter = 0;
  private nextSubId(topic: string): number {
    return ++this.subCounter;
  }
}

// ── 判定 ─────────────────────────────────────────────────────────

/** 信封是否来自其他节点(回环保护) */
export function isRemote(
  envelope: BusEnvelope,
  localNodeId: string,
): boolean {
  return envelope.sourceNode !== localNodeId;
}

// ── 便捷装配 ─────────────────────────────────────────────────────

/**
 * 把进程内 EventBus 升级为跨进程版。
 * 返回 { local: 原总线, remote: 跨进程封装, bridge: 底层总线 }。
 */
export function bridgeEventBus(
  local: EventBus,
  bridge: BusBridge,
): { local: EventBus; remote: EventBus; bridge: BusBridge } {
  return {
    local,
    remote: new RemoteEventBus(local, bridge),
    bridge,
  };
}

/** 供测试/示例使用: 构建一条 demo 事件 */
export function demoEvent(
  layer: LayerId,
  type: string,
  payload: unknown,
  traceId?: string,
): SystemEvent {
  return {
    seq: 0,
    timestamp: new Date().toISOString(),
    type,
    layer,
    payload,
    ...(traceId ? { traceId } : {}),
  };
}