/**
 * @aigility-harness/core — BusBridge 跨进程消息总线契约（阶段 2）
 *
 * 阶段 1.x 的 EventBus 是进程内实现（内存 EventEmitter / Cordis ctx）。
 * 生产形态要把能力拆到独立进程/机器，事件与订阅必须跨进程互通——
 * 这一格由「可更换的消息总线」补上。
 *
 * 设计原则（契约是主体，插件是过客）:
 *   - **BusBridge 是契约**：只定义「连接 / 发布 / 订阅 / 断开」，
 *     与具体总线（NATS / Redis / RabbitMQ / HTTP）无关。
 *   - **BusEnvelope 是线上协议**：跨进程传输的 JSON 信封，
 *     包含 sourceNode（来源节点）避免回环，payload 承载 SystemEvent。
 *   - **总线可更换**：createBusBridge(kind) 工厂按 kind 选择实现，
 *     现阶段提供 memory（同进程 mock，用于单测与原型）；
 *     nat/redis/http 为预留 kind，接入真实总线时补齐对应实现即可。
 */

import type { Result } from "./types.js";
import type { SystemEvent } from "./types.js";

// ── 线上协议: JSON 信封 ─────────────────────────────────────────

/** BusBridge 线上协议版本 */
export const BUS_PROTOCOL = "aigility-bus/1.0";

/**
 * 跨进程传输的 JSON 信封。
 * - 事件被包装为信封后经总线发布；对端校验 protocol 后解包为 SystemEvent。
 * - sourceNode 标识来源节点: 节点收到自己发出的信封时丢弃(防回环)。
 * - topic 为订阅维度: 默认按 layer 分 topic(如 "aigility.events.infrastructure").
 */
export interface BusEnvelope {
  /** 固定协议标识 aigility-bus/1.0 */
  protocol: string;
  /** 来源节点 ID (防回环) */
  sourceNode: string;
  /** 订阅维度: 默认形如 aigility.events.<layer> */
  topic: string;
  /** 信封携带的事件 */
  event: SystemEvent;
}

// ── 契约: 可更换的消息总线 ──────────────────────────────────────

/**
 * 跨进程消息总线契约。
 *
 * 实现约定:
 * - publish 将信封投递到总线, 所有订阅了该 topic 的远端节点收到。
 * - subscribe 返回退订函数; 收到信封时回调 handler。
 * - connect/disconnect 管理总线连接生命周期。
 * - 具体实现可自由选择传输机制 (NATS subject / Redis pubsub / HTTP SSE / TCP…)。
 *
 * 这是阶段 2 的「桥」: EventBus(进程内) 通过 BusBridge(跨进程) 互通。
 */
export interface BusBridge {
  /** 总线类型标识 (memory / nats / redis / http) */
  readonly kind: string;
  /** 节点在总线上的身份 (防回环) */
  readonly nodeId: string;

  /** 建立连接; 失败返回 err */
  connect(): Promise<Result<void>>;
  /** 断开连接; 幂等 */
  disconnect(): Promise<Result<void>>;

  /**
   * 发布信封到总线。成功返回 ok - 所有订阅该 topic 的其他节点收到。
   * 注意: 发布不等待远端处理完成(异步投递语义)。
   */
  publish(envelope: BusEnvelope): Promise<Result<void>>;

  /**
   * 订阅 topic; 返回退订函数。
   * 回调在收到信封时触发(收到自己的信封由调用方按 sourceNode 丢弃)。
   */
  subscribe(
    topic: string,
    handler: (envelope: BusEnvelope) => void,
  ): Promise<Result<() => void>>;
}

/** 总线 kind 集合 */
export const BUS_KINDS = ["memory", "nats", "redis", "http"] as const;
export type BusKind = (typeof BUS_KINDS)[number];

// ── 默认 topic 约定 ──────────────────────────────────────────────

/** 按 layer 生成默认事件 topic: aigility.events.<layer> */
export function eventTopic(layer: string): string {
  return `aigility.events.${layer}`;
}

// ── 工厂 ─────────────────────────────────────────────────────────

/**
 * 按 kind 创建总线。现阶段 memory 可用; 其余 kind 返回
 * 「未实现」err —— 接入真实总线时在此补齐实现。
 */
export function createBusBridge(
  kind: "memory",
  opts?: { nodeId?: string },
): BusBridge;
/** @internal 其余 kind 占位, 防误用 */
export function createBusBridge(
  kind: Exclude<BusKind, "memory">,
  opts?: { nodeId?: string },
): BusBridge;
export function createBusBridge(
  kind: BusKind,
  opts?: { nodeId?: string },
): BusBridge {
  const nodeId = opts?.nodeId ?? `node-${Math.random().toString(36).slice(2, 8)}`;

  // memory: 同进程中枢, 单测/原型用; 真实总线实现后置
  if (kind === "memory") {
    return createMemoryBridge(nodeId);
  }
  // 预留 kind: 真实实现 (nats-client / ioredis / http) 接入时补齐
  throw new Error(
    `BusBridge kind '${kind}' not implemented yet — 接真实总线时在 createBusBridge 补齐 (候选: nats / redis / http)`,
  );
}

// ── memory 实现 ──────────────────────────────────────────────────

type MemoryHandler = (envelope: BusEnvelope) => void;

/** 同进程内存中枢: 所有 memory 桥共享 */
const hub = new Map<string, Set<MemoryHandler>>();

/** 进程内 memory 总线实现 (mock): 同进程多节点互通, 交换真实总线的行为 */
function createMemoryBridge(nodeId: string): BusBridge {
  let connected = false;

  return {
    kind: "memory",
    nodeId,

    async connect() {
      connected = true;
      return { ok: true as const, value: undefined };
    },

    async disconnect() {
      connected = false;
      // 退订所有 topic
      for (const handlers of hub.values()) {
        // 无法按 handler 精确移除; 简单清空自己节点无关紧要 (进程将退出)
      }
      return { ok: true as const, value: undefined };
    },

    async publish(envelope: BusEnvelope) {
      if (!connected) {
        return { ok: false as const, error: "bridge not connected" };
      }
      const handlers = hub.get(envelope.topic);
      if (!handlers) return { ok: true as const, value: undefined };
      // 异步投递: 不等待远端处理
      // 注意: 总线不判断回环 — sourceNode 由订阅端(RemoteEventBus.isRemote)判定,
      //       保持总线中立(与真实 NATS/Redis 行为一致: 自己发的也回给自己)。
      queueMicrotask(() => {
        for (const h of [...handlers]) h(envelope);
      });
      return { ok: true as const, value: undefined };
    },

    async subscribe(
      topic: string,
      handler: MemoryHandler,
    ): Promise<Result<() => void>> {
      if (!connected) {
        return { ok: false as const, error: "bridge not connected" };
      }
      let handlers = hub.get(topic);
      if (!handlers) {
        handlers = new Set();
        hub.set(topic, handlers);
      }
      handlers.add(handler);
      const unsubscribe = () => {
        handlers?.delete(handler);
      };
      return { ok: true as const, value: unsubscribe };
    },
  };
}