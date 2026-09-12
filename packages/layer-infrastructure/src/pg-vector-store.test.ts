/**
 * PgVectorStore 集成测试 — 真实 PostgreSQL pgvector
 *
 * 前提: DATABASE_URL 指向可用 PG 且装有 pgvector 扩展
 * (缺 DATABASE_URL 跳过; 有库无扩展也跳过真库用例)。
 *
 * 验证:
 *   1. metric 映射: 操作符/索引 class/距离→score 换算
 *   2. vectorLiteral 字面量格式
 *   3. upsert 幂等(同 id 覆盖) + count
 *   4. search TOP-K 相似度降序 + score 语义(高分更相似)
 *   5. metadata @> 过滤
 *   6. remove 幂等
 */
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import {
  createPgVectorStore,
  METRIC_MAPPINGS,
  vectorLiteral,
  vectorStoreSetupSql,
} from "./pg-vector-store.js";

const connStr = process.env.DATABASE_URL;

/** 随机表名避免测试间冲突 */
const table = `aigility_vectors_test_${Date.now().toString(36)}`;

describe("pg-vector-store 纯单元", () => {
  it("metric 映射: 操作符 + 索引 class", () => {
    expect(METRIC_MAPPINGS.cosine.distanceOp).toBe("<=>");
    expect(METRIC_MAPPINGS.cosine.opsClass).toBe("vector_cosine_ops");
    expect(METRIC_MAPPINGS.l2.distanceOp).toBe("<->");
    expect(METRIC_MAPPINGS.l2.opsClass).toBe("vector_l2_ops");
    expect(METRIC_MAPPINGS.inner_product.distanceOp).toBe("<#>");
    expect(METRIC_MAPPINGS.inner_product.opsClass).toBe("vector_ip_ops");
  });

  it("距离→score 换算: 高分更相似", () => {
    // cosine: d∈[0,2], score=1-d, 同向 d=0 → score=1 最高
    expect(METRIC_MAPPINGS.cosine.toScore(0)).toBe(1);
    expect(METRIC_MAPPINGS.cosine.toScore(0.2)).toBeCloseTo(0.8);
    // l2: score=1/(1+d), 近者分高
    expect(METRIC_MAPPINGS.l2.toScore(0)).toBe(1);
    expect(METRIC_MAPPINGS.l2.toScore(1)).toBeCloseTo(0.5);
    expect(METRIC_MAPPINGS.l2.toScore(3)).toBeLessThan(METRIC_MAPPINGS.l2.toScore(1));
    // inner_product: pgvector <#> 返回负内积, -d 还原; 内积大者更相似、分更高
    expect(METRIC_MAPPINGS.inner_product.toScore(-5)).toBe(5);
    expect(METRIC_MAPPINGS.inner_product.toScore(-5)).toBeGreaterThan(
      METRIC_MAPPINGS.inner_product.toScore(-3),
    );
  });

  it("vectorLiteral: number[] → '[1,2,3]'", () => {
    expect(vectorLiteral([1, 2, 3])).toBe("[1,2,3]");
  });

  it("vectorStoreSetupSql: 扩展 + 维度固定表 + HNSW 索引", () => {
    const sql = vectorStoreSetupSql("aigility_vectors_cosine", 4, "cosine");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("vector(4)");
    expect(sql).toContain("USING hnsw (embedding vector_cosine_ops)");
  });
});

/** pgvector 扩展可用性探测(有库无扩展时跳过真库用例) */
const pgvectorAvailable = async (): Promise<boolean> => {
  if (!connStr) return false;
  try {
    const client = new pg.Client({ connectionString: connStr });
    await client.connect();
    const res = await client.query(
      "SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'",
    );
    await client.end();
    return res.rows[0].n > 0;
  } catch {
    return false;
  }
};

describe.skipIf(!(await pgvectorAvailable()))("pg-vector-store 真库集成", () => {
  const store = createPgVectorStore({
    dims: 4,
    metric: "cosine",
    connectionString: connStr,
    table,
  });

  afterAll(async () => {
    await store.close();
  });

  it("upsert 幂等: 同 id 覆盖, count 正确", async () => {
    const u1 = await store.upsert([
      { id: "a", vector: [1, 0, 0, 0], metadata: { tag: "x" } },
      { id: "b", vector: [0, 1, 0, 0] },
    ]);
    expect(u1.ok).toBe(true);
    // 同 id 再写: 覆盖不报错, count 仍为 2
    const u2 = await store.upsert([
      { id: "a", vector: [0.9, 0.1, 0, 0], metadata: { tag: "x", v: 2 } },
    ]);
    expect(u2.ok).toBe(true);
    const c = await store.count();
    expect(c.ok).toBe(true);
    expect(c.value).toBe(2);
  });

  it("search TOP-K: 相似度降序 + score 语义", async () => {
    // 查询向量贴近 a: a 应排第一且 score 高
    const r = await store.search([1, 0, 0, 0], { topK: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(2);
    expect(r.value[0].id).toBe("a");
    // cosine: 近乎同向 → score 接近 1
    expect(r.value[0].score).toBeGreaterThan(0.95);
    // 降序
    expect(r.value[0].score).toBeGreaterThanOrEqual(r.value[1].score);
  });

  it("metadata @> 过滤: 只命中包含该键值的点", async () => {
    const r = await store.search([1, 0, 0, 0], {
      topK: 10,
      filter: { tag: "x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(1);
    expect(r.value[0].id).toBe("a");
    expect(r.value[0].metadata).toEqual({ tag: "x", v: 2 });
  });

  it("remove 幂等: 删除后查不到, 重复删除不报错", async () => {
    const r1 = await store.remove(["b"]);
    expect(r1.ok).toBe(true);
    const r2 = await store.remove(["b", "not-exists"]);
    expect(r2.ok).toBe(true);
    const c = await store.count();
    expect(c.value).toBe(1);
    // 删掉 a 还原现场
    await store.remove(["a"]);
  });
});
