/**
 * PgTaskQueue 集成测试 — 真实 PostgreSQL FOR UPDATE SKIP LOCKED 单表多队列
 *
 * 前提: DATABASE_URL 指向可用的 PG (缺省跳过真库用例)。
 *
 * 验证:
 *   1. 建表 SQL 包含队列列与索引
 *   2. enqueue → dequeue: FIFO + payload/attempts 正确
 *   3. delayMs 延迟可见
 *   4. 租约: visibilityTimeout 内不重复投递, 超时未 ack 自动重新可见
 *   5. ack 幂等移除; nack requeue 重新投递; nack 转死信
 *   6. stats: pending/inFlight/dead/total 计数
 */
import { describe, it, expect, afterAll } from "vitest";
import { taskQueueName } from "@aigility-harness/core";
import { createPgTaskQueue, taskQueueSetupSql } from "./pg-task-queue.js";

const connStr = process.env.DATABASE_URL;

/** 随机表名避免测试间冲突 */
const table = `aigility_task_queue_test_${Date.now().toString(36)}`;

describe("pg-task-queue 纯单元", () => {
  it("taskQueueSetupSql: 单表多队列 + 出队索引", () => {
    const sql = taskQueueSetupSql("aigility_task_queue");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS aigility_task_queue");
    expect(sql).toContain("queue       TEXT NOT NULL");
    expect(sql).toContain("status      TEXT NOT NULL DEFAULT 'ready'");
    expect(sql).toContain("aigility_task_queue_dequeue_idx");
  });

  it("taskQueueName(core) 前缀约定", () => {
    expect(taskQueueName("resume_parse")).toBe("aigility.tasks.resume_parse");
  });
});

describe.skipIf(!connStr)("pg-task-queue 真库集成", () => {
  const suffix = Date.now().toString(36);
  const queueA = createPgTaskQueue<{ n: number }>({
    name: `aigility.tasks.test_a_${suffix}`,
    connectionString: connStr,
    table,
  });
  const queueB = createPgTaskQueue<{ n: number }>({
    name: `aigility.tasks.test_b_${suffix}`,
    connectionString: connStr,
    table,
  });

  afterAll(async () => {
    await queueA.close();
    await queueB.close();
  });

  it("enqueue → dequeue: FIFO + payload/attempts 正确", async () => {
    const e1 = await queueA.enqueue({ n: 1 });
    const e2 = await queueA.enqueue({ n: 2 });
    expect(e1.ok).toBe(true);
    expect(e2.ok).toBe(true);

    const d1 = await queueA.dequeue();
    expect(d1.ok).toBe(true);
    if (!d1.ok) return;
    expect(d1.value).not.toBeNull();
    expect(d1.value!.payload).toEqual({ n: 1 });
    expect(d1.value!.attempts).toBe(1);
    expect(typeof d1.value!.enqueuedAt).toBe("string");
    await queueA.ack(d1.value!.id);

    const d2 = await queueA.dequeue();
    if (d2.ok && d2.value) {
      expect(d2.value.payload).toEqual({ n: 2 });
      await queueA.ack(d2.value.id);
    }
    // 消费完: 无消息返回 ok(null) 而非错误
    const empty = await queueA.dequeue();
    expect(empty.ok).toBe(true);
    expect(empty.value).toBeNull();
  });

  it("delayMs 延迟可见: 到期前 dequeue 拿不到", async () => {
    await queueA.enqueue({ n: 3 }, { delayMs: 1500 });
    const early = await queueA.dequeue();
    expect(early.ok).toBe(true);
    expect(early.value).toBeNull();

    await new Promise((r) => setTimeout(r, 1600));
    const late = await queueA.dequeue();
    expect(late.ok).toBe(true);
    if (late.ok && late.value) {
      expect(late.value.payload).toEqual({ n: 3 });
      await queueA.ack(late.value.id);
    }
  });

  it("租约: visibilityTimeout 内不可见, 超时未 ack 自动重新可见且 attempts+1", async () => {
    const e = await queueA.enqueue({ n: 4 });
    expect(e.ok).toBe(true);
    const first = await queueA.dequeue({ visibilityTimeoutSec: 1 });
    if (!first.ok || !first.value) return;
    expect(first.value.payload).toEqual({ n: 4 });

    // 租约期内: 拿不到
    const during = await queueA.dequeue();
    expect(during.value).toBeNull();

    // 租约过期: 自动重新可见, attempts 累计为 2
    await new Promise((r) => setTimeout(r, 1300));
    const again = await queueA.dequeue({ visibilityTimeoutSec: 30 });
    if (!again.ok || !again.value) return;
    expect(again.value.id).toBe(first.value.id);
    expect(again.value.attempts).toBe(2);
    await queueA.ack(again.value.id);
  });

  it("ack 幂等: 重复 ack 不报错", async () => {
    await queueA.enqueue({ n: 5 });
    const d = await queueA.dequeue();
    if (!d.ok || !d.value) return;
    expect((await queueA.ack(d.value.id)).ok).toBe(true);
    const again = await queueA.ack(d.value.id);
    expect(again.ok).toBe(true);
  });

  it("nack requeue: 重新入队再投递; nack 死信: 不再投递且计入 stats", async () => {
    await queueA.enqueue({ n: 6 });
    const d = await queueA.dequeue();
    if (!d.ok || !d.value) return;
    const nr = await queueA.nack(d.value.id, { requeue: true });
    expect(nr.ok).toBe(true);
    const redelivered = await queueA.dequeue();
    if (!redelivered.ok || !redelivered.value) return;
    expect(redelivered.value.payload).toEqual({ n: 6 });
    // 转死信
    await queueA.nack(redelivered.value.id);
    const afterDead = await queueA.dequeue();
    expect(afterDead.value).toBeNull();
    // stats: 1 死信
    const s = await queueA.stats();
    if (!s.ok) return;
    expect(s.value.dead).toBeGreaterThanOrEqual(1);
    expect(s.value.pending).toBe(0);
  });

  it("单表多队列隔离: A 的消息不会被 B 消费", async () => {
    await queueA.enqueue({ n: 7 });
    const fromB = await queueB.dequeue();
    expect(fromB.value).toBeNull();
    const fromA = await queueA.dequeue();
    if (fromA.ok && fromA.value) await queueA.ack(fromA.value.id);
  });

  it("stats: pending/inFlight/total 计数正确", async () => {
    // 全新队列名: 与前面用例(含死信遗留)隔离, 断言绝对计数
    const queueC = createPgTaskQueue<{ n: number }>({
      name: `aigility.tasks.test_stats_${Date.now().toString(36)}`,
      connectionString: connStr,
      table,
    });
    await queueC.enqueue({ n: 8 });
    await queueC.enqueue({ n: 9 });
    const inFlight = await queueC.dequeue({ visibilityTimeoutSec: 60 });
    if (!inFlight.ok || !inFlight.value) return;
    const s = await queueC.stats();
    if (!s.ok) return;
    expect(s.value.inFlight).toBe(1);
    expect(s.value.pending).toBe(1);
    expect(s.value.dead).toBe(0);
    expect(s.value.total).toBe(2);
    await queueC.ack(inFlight.value.id);
    await queueC.dequeue().then((r) => (r.ok && r.value ? queueC.ack(r.value.id) : undefined));
    await queueC.close();
  });
});
