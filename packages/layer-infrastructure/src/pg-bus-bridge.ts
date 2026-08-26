/**
 * L5 底座层: PgBusBridge — PostgreSQL 消息总线实现 (阶段 2 落地)
 *
 * 架构决策(2026-08-26): 数据库统一用 PostgreSQL 单库多职——
 * 业务表 + 消息总线 + 队列 + 向量(pgvector)。本文件即「消息总线」一职。
 *
 * 机制:
 *   - LISTEN/NOTIFY: 实时 pub/sub。topic → channel 每个 notify 只承载
 *     「小信封」{topic, sourceNode, seq}, 避开 NOTIFY 8KB payload 限制。
 *   - event_log 表: 每条事件 INSERT 落库(持久化 + 事件溯源), seq 由库自增;
 *     订阅端收到 notify 后按 seq 查表取完整事件(同时获得可靠投递语义)。
 *
 * 与契约的关系: 实现 BusBridge(连接/发布/订阅/断开), 总线中立不做回环判断,
 * 与 memory 桥行为一致; RemoteEventBus 直接可用。
 */

import { BUS_PROTOCOL } from "@aigility-harness/core";
import type { BusBridge, BusEnvelope } from "@aigility-harness/core";
import type { Result } from "@aigility-harness/core";
import pg from "pg";
import { ok, err } from "@aigility-harness/core";

// ── 类型 ─────────────────────────────────────────────────────────

export interface PgBusBridgeOptions {
  /** PostgreSQL 连接串; 缺省用环境变量/libpq 默认 */
  connectionString?: string;
  /** 节点身份(防回环) */
  nodeId?: string;
  /** 事件日志表名 (默认 aigility_event_log) */
  eventTable?: string;
  /** 是否自动建表 (默认 true) */
  autoSetup?: boolean;
}

/** NOTIFY 小信封: 只携带定位信息, 大事件按 seq 查表 */
interface NotifyPayload {
  topic: string;
  sourceNode: string;
  seq: number;
}

// ── 实现 ─────────────────────────────────────────────────────────

/** topic → channel 映射记录 (订阅时登记, 反查用, 避免图层名歧义) */
const topicChannels = new Map<string, string>();

/** topic 转合法 channel 名: aigility.events.infrastructure → aigility_events_infrastructure */
export function channelName(topic: string): string {
  const ch = topic.replace(/[^a-zA-Z0-9_]/g, "_");
  topicChannels.set(ch, topic);
  return ch;
}

/** CREATE TABLE IF NOT EXISTS (event_log) */
export function setupSql(eventTable: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${eventTable} (
      seq       BIGSERIAL PRIMARY KEY,
      topic     TEXT NOT NULL,
      source_node TEXT NOT NULL,
      protocol  TEXT NOT NULL,
      event     JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ${eventTable}_topic_seq_idx
      ON ${eventTable} (topic, seq);
  `;
}

/**
 * 创建 PostgreSQL 总线桥。
 * connect() 时: 建池 → 建表(可选) → 建立通知监听连接(LISTEN 随订阅进行)。
 */
export function createPgBusBridge(
  opts: PgBusBridgeOptions = {},
): BusBridge {
  const nodeId = opts.nodeId ?? `node-${Math.random().toString(36).slice(2, 8)}`;
  const eventTable = opts.eventTable ?? "aigility_event_log";
  const pool = new pg.Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
  });

  /** 通知监听连接(单条, LISTEN 由 subscribe 注册) */
  let notifyClient: pg.Client | null = null;
  let connected = false;

  /** topic → 订阅处理函数 */
  const handlers = new Map<string, Set<(env: BusEnvelope) => void>>();

  return {
    kind: "pg",
    nodeId,

    async connect(): Promise<Result<void>> {
      try {
        if (opts.autoSetup ?? true) {
          await pool.query(setupSql(eventTable));
        }
        // 建立通知监听连接
        notifyClient = new pg.Client({
          connectionString: opts.connectionString ?? process.env.DATABASE_URL,
        });
        await notifyClient.connect();
        typeof notifyClient.on === "function" &&
          notifyClient.on("notification", async (msg) => {
            if (!msg.channel || !msg.payload) return;
            // channel → topic 反查(登记表, 避免图层名歧义)
            const topic = topicChannels.get(msg.channel) ?? msg.channel;
            const parsed = JSON.parse(msg.payload) as NotifyPayload;
            const hs = handlers.get(topic);
            if (!hs || hs.size === 0) return;
            // 按 seq 查完整事件
            const res = await pool.query(
              `SELECT event FROM ${eventTable} WHERE seq = $1`,
              [parsed.seq],
            );
            if (res.rowCount === 0 || !res.rows[0]) return;
            const envelope: BusEnvelope = {
              protocol: BUS_PROTOCOL,
              sourceNode: parsed.sourceNode,
              topic,
              event: res.rows[0].event as never,
            };
            for (const h of [...hs]) h(envelope);
          });
        connected = true;
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async disconnect(): Promise<Result<void>> {
      try {
        connected = false;
        handlers.clear();
        if (notifyClient) {
          await notifyClient.end();
          notifyClient = null;
        }
        await pool.end();
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async publish(envelope: BusEnvelope): Promise<Result<void>> {
      if (!connected) return err("bridge not connected");
      try {
        // 1. 事件落库(持久化 + 拿自增 seq)
        const ins = await pool.query(
          `INSERT INTO ${eventTable} (topic, source_node, protocol, event)
           VALUES ($1, $2, $3, $4) RETURNING seq`,
          [envelope.topic, envelope.sourceNode, envelope.protocol, JSON.stringify(envelope.event)],
        );
        const seq = ins.rows[0].seq as number;
        // 2. NOTIFY 小信封(实时投递, 8KB 内)
        const payload = JSON.stringify({
          topic: envelope.topic,
          sourceNode: envelope.sourceNode,
          seq,
        } satisfies NotifyPayload);
        await pool.query(`SELECT pg_notify($1, $2)`, [
          channelName(envelope.topic),
          payload,
        ]);
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async subscribe(
      topic: string,
      handler: (envelope: BusEnvelope) => void,
    ): Promise<Result<() => void>> {
      if (!connected || !notifyClient) return err("bridge not connected");
      try {
        // 注册处理函数
        let hs = handlers.get(topic);
        if (!hs) {
          hs = new Set();
          handlers.set(topic, hs);
        }
        hs.add(handler);
        // LISTEN channel(幂等) — channelName 同时登记 topicChannels 映射
        await notifyClient.query(`LISTEN ${channelName(topic)}`);
        const unsubscribe = () => {
          hs?.delete(handler);
        };
        return ok(unsubscribe);
      } catch (e) {
        return err(String(e));
      }
    },
  };
}