/**
 * L1 底座层: PgTaskQueue — PostgreSQL 任务队列实现 (FOR UPDATE SKIP LOCKED)
 *
 * 架构决策(2026-08-26): 数据库统一用 PostgreSQL 单库多职——
 * 业务表 + 消息总线 + 队列 + 向量(pgvector)。本文件即「任务队列」一职。
 *
 * 机制(无需任何扩展, 原生 PG 即可):
 *   - 单表多队列: queue 列区分队列, status 列区分 ready/dead。
 *   - 租约式消费: dequeue 用 FOR UPDATE SKIP LOCKED 抢一条
 *     visible_at <= now() 的消息, 置 visible_at = now() + visibilityTimeout;
 *     崩溃未 ack 时租约到期自动重新可见(对齐 SQS / pgmq 行为)。
 *   - attempts 在 dequeue 时 +1(read count, 对齐 pgmq read_ct);
 *     nack requeue 只重置 visible_at, 不重复计数。
 *
 * 与契约的关系: 实现 core 的 TaskQueue<T>(enqueue/dequeue/ack/nack/stats)。
 * 若部署环境装有 pgmq 扩展, 可另写 createPgmqQueue 按同契约替换, 上层零改动。
 */

import pg from "pg";
import { ok, err } from "@aigility-harness/core";
import type { Result, QueueMessage, TaskQueue } from "@aigility-harness/core";

// ── 类型 ─────────────────────────────────────────────────────────

export interface PgTaskQueueOptions {
  /** 队列名(建议用 core 的 taskQueueName() 生成) */
  name: string;
  /** PostgreSQL 连接串; 缺省用环境变量 DATABASE_URL / libpq 默认 */
  connectionString?: string;
  /** 共享连接池(多队列复用一个池时传入, 否则实例自建) */
  pool?: pg.Pool;
  /** 表名 (默认 aigility_task_queue, 全部队列共用单表) */
  table?: string;
  /** 是否自动建表 (默认 true) */
  autoSetup?: boolean;
}

/** PgTaskQueue = 契约 TaskQueue + close(自建池时释放; 传入的池不关) */
export interface PgTaskQueue<T = unknown> extends TaskQueue<T> {
  /** 释放自建连接池(传入共享池时为空操作) */
  close(): Promise<void>;
}

// ── 建表 SQL ─────────────────────────────────────────────────────

/** CREATE TABLE IF NOT EXISTS (单表多队列) */
export function taskQueueSetupSql(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      id          TEXT PRIMARY KEY,
      queue       TEXT NOT NULL,
      payload     JSONB NOT NULL,
      attempts    INT NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'ready',
      enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      visible_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ${table}_dequeue_idx
      ON ${table} (queue, status, visible_at, enqueued_at);
  `;
}

// ── 实现 ─────────────────────────────────────────────────────────

/**
 * 创建 PostgreSQL 任务队列(FOR UPDATE SKIP LOCKED 实现)。
 * 首次调用时自动建表(可选); 多实例共用一张表, 靠 queue 列隔离。
 */
export function createPgTaskQueue<T = unknown>(
  opts: PgTaskQueueOptions,
): PgTaskQueue<T> {
  const name = opts.name;
  const table = opts.table ?? "aigility_task_queue";
  const ownPool = !opts.pool;
  const pool = opts.pool ?? new pg.Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
  });
  const kind = "skip-locked";

  /** 建表只做一次(并发调用共享同一 Promise) */
  let setupPromise: Promise<void> | null = null;
  const setup = (): Promise<void> => {
    if (!(opts.autoSetup ?? true)) return Promise.resolve();
    setupPromise ??= pool.query(taskQueueSetupSql(table)).then(() => undefined);
    return setupPromise;
  };

  return {
    name,
    kind,

    async enqueue(
      payload: T,
      enqueueOpts?: { delayMs?: number },
    ): Promise<Result<string>> {
      try {
        await setup();
        const id = crypto.randomUUID();
        const delayMs = enqueueOpts?.delayMs ?? 0;
        await pool.query(
          `INSERT INTO ${table} (id, queue, payload, visible_at)
           VALUES ($1, $2, $3::jsonb, now() + ($4::int * interval '1 millisecond'))`,
          [id, name, JSON.stringify(payload ?? null), delayMs],
        );
        return ok(id);
      } catch (e) {
        return err(String(e));
      }
    },

    async dequeue(
      dequeueOpts?: { visibilityTimeoutSec?: number },
    ): Promise<Result<QueueMessage<T> | null>> {
      try {
        await setup();
        const timeoutSec = dequeueOpts?.visibilityTimeoutSec ?? 30;
        // SKIP LOCKED: 并发消费者互不阻塞、互不重复
        const res = await pool.query(
          `UPDATE ${table} SET attempts = attempts + 1, visible_at = now() + ($2::int * interval '1 second')
           WHERE id = (
             SELECT id FROM ${table}
             WHERE queue = $1 AND status = 'ready' AND visible_at <= now()
             ORDER BY enqueued_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, payload, attempts, enqueued_at`,
          [name, timeoutSec],
        );
        if (res.rowCount === 0 || !res.rows[0]) return ok(null);
        const row = res.rows[0];
        // pg 驱动把 TIMESTAMPTZ 直接返回为 Date 对象(字符串仅见于纯文本协议)
        const enqueuedAtDate =
          row.enqueued_at instanceof Date
            ? row.enqueued_at
            : new Date(row.enqueued_at as string);
        const msg: QueueMessage<T> = {
          id: row.id as string,
          payload: row.payload as T,
          enqueuedAt: enqueuedAtDate.toISOString(),
          attempts: row.attempts as number,
        };
        return ok(msg);
      } catch (e) {
        return err(String(e));
      }
    },

    async ack(messageId: string): Promise<Result<void>> {
      try {
        // 幂等: 租约过期被他人重新消费后, 原消费者的 ack 静默跳过
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [messageId]);
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async nack(
      messageId: string,
      nackOpts?: { requeue?: boolean },
    ): Promise<Result<void>> {
      try {
        if (nackOpts?.requeue) {
          // 立刻重新可见; attempts 不再 +1(dequeue 时已计)
          await pool.query(
            `UPDATE ${table} SET status = 'ready', visible_at = now() WHERE id = $1`,
            [messageId],
          );
        } else {
          await pool.query(
            `UPDATE ${table} SET status = 'dead' WHERE id = $1`,
            [messageId],
          );
        }
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async stats(): Promise<
      Result<{
        pending: number;
        inFlight: number;
        dead: number;
        total: number;
      }>
    > {
      try {
        await setup();
        const res = await pool.query(
          `SELECT
             count(*) FILTER (WHERE status = 'ready' AND visible_at <= now()) AS pending,
             count(*) FILTER (WHERE status = 'ready' AND visible_at > now())  AS in_flight,
             count(*) FILTER (WHERE status = 'dead')                          AS dead,
             count(*)                                                          AS total
           FROM ${table} WHERE queue = $1`,
          [name],
        );
        const row = res.rows[0];
        return ok({
          pending: Number(row.pending),
          inFlight: Number(row.in_flight),
          dead: Number(row.dead),
          total: Number(row.total),
        });
      } catch (e) {
        return err(String(e));
      }
    },

    async close(): Promise<void> {
      if (ownPool) await pool.end();
    },
  };
}
