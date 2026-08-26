/**
 * @aigility-harness/core — TaskQueue 任务队列契约（PG 单库化: 任务队列一职）
 *
 * 架构决策(2026-08-26): 数据库统一用 PostgreSQL 单库多职。
 * 任务队列是四职之一, 由 PG 的 pgmq 扩展或 FOR UPDATE SKIP LOCKED 实现,
 * 替代 Redis / RabbitMQ / Celery broker 分散中间件。
 *
 * 设计原则(契约是主体, 插件是过客):
 *   - TaskQueue 是契约: 只定义 入队/消费/确认/失败/统计,
 *     与底层实现(pgmq / SKIP LOCKED / Redis Stream…)无关。
 *   - 实现可更换: createQueue("pgmq") / createQueue("skip-locked") /
 *     createQueue("redis") 按部署环境选定, 上层业务零改动。
 *
 * 语义对齐业界标准队列(pgmq / SQS / RabbitMQ 消费者):
 *   - enqueue      入队(支持延迟)
 *   - dequeue      租约式消费(已出队未 ack 的消息在租约到期后重新可见)
 *   - ack          完成(从队列移除)
 *   - nack         失败(标记死信或重新入队重试)
 */

import type { Result } from "./types.js";

// ── 消息形态 ─────────────────────────────────────────────────────

/** 队列中的一条消息 */
export interface QueueMessage<T = unknown> {
  /** 消息 ID (队列内唯一, 用于 ack/nack) */
  id: string;
  /** 业务载荷 */
  payload: T;
  /** 入队时间 ISO 8601 */
  enqueuedAt: string;
  /** 已尝试消费次数 (重试计数) */
  attempts: number;
}

// ── 契约: 可更换的任务队列 ───────────────────────────────────────

/**
 * 任务队列契约。
 *
 * 实现约定:
 * - enqueue 入队, 返回消息 ID; delayMs>0 时到期后才可被 dequeue。
 * - dequeue 租约式: 出队后消息在 visibilityTimeout 内不可见;
 *   超时未 ack 自动重新可见(崩溃恢复), 与 SQS/pgmq 行为一致。
 * - ack 确认完成(永久移除); nack 标记失败(按策略重试或转死信)。
 * - 具体实现自由选择: pgmq / FOR UPDATE SKIP LOCKED / Redis Stream。
 */
export interface TaskQueue<T = unknown> {
  /** 队列名(默认如 aigility.tasks.resume_parse) */
  readonly name: string;
  /** 队列类型标识 (pgmq / skip-locked / redis / memory) */
  readonly kind: string;

  /**
   * 入队一条任务。返回消息 ID。
   * opts.delayMs > 0 时消息延迟可见(到期前 dequeue 不会返回)。
   */
  enqueue(
    payload: T,
    opts?: { delayMs?: number },
  ): Promise<Result<string>>;

  /**
   * 租约式消费: 取一条可见消息。
   * 无消息时返回 ok(null)(非错误)。返回消息在 visibilityTimeout
   * 内不可见, 超时未 ack 自动重新可见。
   */
  dequeue(opts?: {
    /** 可见性超时(秒), 租约时长; 默认 30 */
    visibilityTimeoutSec?: number;
  }): Promise<Result<QueueMessage<T> | null>>;

  /** 确认完成: 永久移除消息 */
  ack(messageId: string): Promise<Result<void>>;

  /** 标记失败: requeue=true 重新入队(attempts+1), 否则进死信 */
  nack(
    messageId: string,
    opts?: { requeue?: boolean },
  ): Promise<Result<void>>;

  /** 队列统计 */
  stats(): Promise<
    Result<{
      /** 可见待处理 */
      pending: number;
      /** 租约中(已出队未确认) */
      inFlight: number;
      /** 死信 */
      dead: number;
      /** 总量 */
      total: number;
    }>
  >;
}

// ── 队列名约定 ───────────────────────────────────────────────────

/** 默认队列名前缀: aigility.tasks.<name> */
export function taskQueueName(name: string): string {
  return `aigility.tasks.${name}`;
}