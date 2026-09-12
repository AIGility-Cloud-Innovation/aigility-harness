/**
 * L1 底座层: PgVectorStore — pgvector 向量检索实现
 *
 * 架构决策(2026-08-26): 数据库统一用 PostgreSQL 单库多职——
 * 业务表 + 消息总线 + 队列 + 向量(pgvector)。本文件即「向量检索」一职。
 *
 * 机制(需 PG 装有 pgvector 扩展):
 *   - 单表单索引: 每个实例一张表(维度固定, embedding vector(dims)),
 *     HNSW 索引按 metric 选 ops class(vector_cosine/l2/ip_ops)。
 *   - 距离→相似度: pgvector 三种操作符都返回「距离」(越小越相似),
 *     契约要求 score 高分更相似, 统一换算:
 *       cosine        1 - d      (d = 欧氏意义下的余弦距离, 0 同向, 1 正交, 2 反向)
 *       l2            1 / (1+d)
 *       inner_product -d         (pgvector <#> 返回负内积)
 *   - metadata 过滤用 JSONB 包含 (@>): 等值与嵌套包含均支持。
 *
 * 与契约的关系: 实现 core 的 VectorStore(upsert/search/remove/count)。
 * 将来向量量大到 PG 不够用, 换 Milvus 实现按同契约替换, 上层 rag/memory 零改动。
 */

import pg from "pg";
import { ok, err } from "@aigility-harness/core";
import type {
  Result,
  VectorPoint,
  VectorSearchHit,
  VectorMetric,
  VectorStore,
} from "@aigility-harness/core";

// ── 类型 ─────────────────────────────────────────────────────────

export interface PgVectorStoreOptions {
  /** 向量维度(建表固定, 后续不可变) */
  dims: number;
  /** 距离度量 (默认 cosine) */
  metric?: VectorMetric;
  /** PostgreSQL 连接串; 缺省用环境变量 DATABASE_URL / libpq 默认 */
  connectionString?: string;
  /** 共享连接池(多实例复用一个池时传入, 否则实例自建) */
  pool?: pg.Pool;
  /** 表名 (默认 aigility_vectors_<metric>, 不同 metric 用不同表以匹配索引) */
  table?: string;
  /** 是否自动建扩展+表 (默认 true; 建扩展需超级用户) */
  autoSetup?: boolean;
}

/** PgVectorStore = 契约 VectorStore + close(自建池时释放; 传入的池不关) */
export interface PgVectorStore extends VectorStore {
  /** 释放自建连接池(传入共享池时为空操作) */
  close(): Promise<void>;
}

// ── metric → pgvector 操作符/索引 class 映射 ─────────────────────

interface MetricMapping {
  /** 距离操作符 (返回距离 d, 越小越相似) */
  distanceOp: string;
  /** HNSW 索引 ops class */
  opsClass: string;
  /** 距离 d → 契约相似度 score (高分更相似) */
  toScore: (d: number) => number;
}

/** 单测可断言的 metric 映射表 */
export const METRIC_MAPPINGS: Record<VectorMetric, MetricMapping> = {
  cosine: {
    distanceOp: "<=>",
    opsClass: "vector_cosine_ops",
    toScore: (d) => 1 - d,
  },
  l2: {
    distanceOp: "<->",
    opsClass: "vector_l2_ops",
    toScore: (d) => 1 / (1 + d),
  },
  inner_product: {
    distanceOp: "<#>",
    opsClass: "vector_ip_ops",
    toScore: (d) => -d,
  },
};

/** number[] → pgvector 字面量 '[1,2,3]' */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ── 建表 SQL ─────────────────────────────────────────────────────

/** CREATE EXTENSION + TABLE + HNSW 索引 */
export function vectorStoreSetupSql(table: string, dims: number, metric: VectorMetric): string {
  const { opsClass } = METRIC_MAPPINGS[metric];
  return `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS ${table} (
      id        TEXT PRIMARY KEY,
      embedding vector(${dims}) NOT NULL,
      metadata  JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS ${table}_hnsw_idx
      ON ${table} USING hnsw (embedding ${opsClass});
  `;
}

// ── 实现 ─────────────────────────────────────────────────────────

/**
 * 创建 pgvector 向量检索。
 * 首次调用时自动建扩展+表+索引(可选); 建扩展失败(未安装/非超级用户)
 * 会以 err 形式暴露在首次调用上, 便于上层感知降级。
 */
export function createPgVectorStore(
  opts: PgVectorStoreOptions,
): PgVectorStore {
  const dims = opts.dims;
  const metric: VectorMetric = opts.metric ?? "cosine";
  const table =
    opts.table ?? `aigility_vectors_${metric}`;
  const ownPool = !opts.pool;
  const pool = opts.pool ?? new pg.Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
  });
  const { distanceOp, toScore } = METRIC_MAPPINGS[metric];

  /** 建扩展+表只做一次(并发调用共享同一 Promise) */
  let setupPromise: Promise<Result<void>> | null = null;
  const setup = (): Promise<Result<void>> => {
    if (!(opts.autoSetup ?? true)) return Promise.resolve(ok(undefined));
    setupPromise ??= pool
      .query(vectorStoreSetupSql(table, dims, metric))
      .then(() => ok(undefined) as Result<void>)
      .catch((e) => err(String(e)) as Result<void>);
    return setupPromise;
  };

  return {
    kind: "pgvector",
    dims,
    metric,

    async upsert(points: VectorPoint[]): Promise<Result<void>> {
      try {
        const s = await setup();
        if (!s.ok) return s;
        // 单事务批量写, 同 id ON CONFLICT 覆盖(幂等)
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const p of points) {
            await client.query(
              `INSERT INTO ${table} (id, embedding, metadata)
               VALUES ($1::text, $2::vector, $3::jsonb)
               ON CONFLICT (id) DO UPDATE
                 SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
              [p.id, vectorLiteral(p.vector), JSON.stringify(p.metadata ?? {})],
            );
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async search(
      vector: number[],
      searchOpts?: {
        topK?: number;
        filter?: Record<string, unknown>;
      },
    ): Promise<Result<VectorSearchHit[]>> {
      try {
        const s = await setup();
        if (!s.ok) return s;
        const topK = searchOpts?.topK ?? 10;
        const filter = searchOpts?.filter;
        const hasFilter =
          filter !== undefined && Object.keys(filter).length > 0;
        // 距离升序 = 相似度降序; score 由距离换算(高分更相似)
        const sql = `
          SELECT id, metadata,
                 embedding ${distanceOp} $1::vector AS dist
          FROM ${table}
          ${hasFilter ? "WHERE metadata @> $2::jsonb" : ""}
          ORDER BY embedding ${distanceOp} $1::vector ASC
          LIMIT ${hasFilter ? "$3" : "$2"}`;
        const params: unknown[] = hasFilter
          ? [vectorLiteral(vector), JSON.stringify(filter), topK]
          : [vectorLiteral(vector), topK];
        const res = await pool.query(sql, params);
        const hits: VectorSearchHit[] = res.rows.map((row) => {
          const hit: VectorSearchHit = {
            id: row.id as string,
            score: toScore(Number(row.dist)),
          };
          const meta = row.metadata;
          if (meta && Object.keys(meta as object).length > 0) {
            hit.metadata = meta as Record<string, unknown>;
          }
          return hit;
        });
        return ok(hits);
      } catch (e) {
        return err(String(e));
      }
    },

    async remove(ids: string[]): Promise<Result<void>> {
      try {
        const s = await setup();
        if (!s.ok) return s;
        // 幂等: 不存在的 id 静默跳过
        await pool.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
        return ok(undefined);
      } catch (e) {
        return err(String(e));
      }
    },

    async count(): Promise<Result<number>> {
      try {
        const s = await setup();
        if (!s.ok) return s;
        const res = await pool.query(`SELECT count(*) AS n FROM ${table}`);
        return ok(Number(res.rows[0].n));
      } catch (e) {
        return err(String(e));
      }
    },

    async close(): Promise<void> {
      if (ownPool) await pool.end();
    },
  };
}
