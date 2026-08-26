/**
 * @aigility-harness/core — VectorStore 向量检索契约（PG 单库化: 向量检索一职）
 *
 * 架构决策(2026-08-26): 数据库统一用 PostgreSQL 单库多职。
 * 向量检索由 pgvector 扩展实现(替代 chroma / qdrant / milvus 独立容器),
 * 用于 @cognitive/rag-retrieval 与 @cognitive/memory 的存储层。
 *
 * 设计原则(契约是主体, 插件是过客):
 *   - VectorStore 是契约: 只定义 写入/搜索/删除/统计,
 *     与底层实现(pgvector / qdrant / faiss / milvus)无关。
 *   - 实现可更换: createVectorStore("pgvector") / ("qdrant") /
 *     ("chroma") 按部署环境选定; 将来向量量大到 PG 不够用时,
 *     换 Milvus 也只动工厂一行, 上层能力(rag/memory)零改动。
 *
 * 语义对齐主流向量库:
 *   - upsert   写入/覆盖(按 id 幂等, 批量)
 *   - search   按相似度 TOP-K (支持 metadata 过滤)
 *   - remove   按 id 删除
 *   - count    存量统计
 */

import type { Result } from "./types.js";

// ── 数据形态 ─────────────────────────────────────────────────────

/** 向量点: id + 向量 + 元数据 */
export interface VectorPoint {
  /** 点 ID (幂等 upsert 依据) */
  id: string;
  /** 向量 (维度须与存储一致) */
  vector: number[];
  /** 可选的元数据 (支持 search 过滤) */
  metadata?: Record<string, unknown>;
}

/** 搜索结果: 命中点 + 相似度分数 */
export interface VectorSearchHit {
  id: string;
  /** 相似度分数 (metric=cosine 时为余弦相似度, 高分更相似) */
  score: number;
  metadata?: Record<string, unknown>;
}

/** 距离度量 */
export type VectorMetric = "cosine" | "l2" | "inner_product";

// ── 契约: 可更换的向量检索 ───────────────────────────────────────

/**
 * 向量检索契约。
 *
 * 实现约定:
 * - upsert 幂等: 同 id 重复写入覆盖, 支持批量。
 * - search 返回 TOP-K, 按 metric 的相似度降序;
 *   filter 对 metadata 做等值/包含过滤(各实现支持度可不同)。
 * - remove 按 id 删除不存在的 id 不报错(幂等)。
 * - 具体实现自由选择: pgvector / qdrant / chroma / onnx+faiss。
 */
export interface VectorStore {
  /** 实现类型标识 (pgvector / qdrant / chroma / faiss) */
  readonly kind: string;
  /** 维度 */
  readonly dims: number;
  /** 距离度量 */
  readonly metric: VectorMetric;

  /** 批量写入/覆盖向量点 (幂等) */
  upsert(points: VectorPoint[]): Promise<Result<void>>;

  /**
   * 相似度搜索: 返回 TOP-K 命中(按相似度降序)。
   * filter 示例: { category: "job", enterpriseId: "E1" } — 各实现支持范围见实现文档。
   */
  search(
    vector: number[],
    opts?: {
      /** 返回条数, 默认 10 */
      topK?: number;
      /** metadata 过滤 (各实现支持度不同) */
      filter?: Record<string, unknown>;
    },
  ): Promise<Result<VectorSearchHit[]>>;

  /** 按 id 删除 (幂等, 不存在的 id 静默跳过) */
  remove(ids: string[]): Promise<Result<void>>;

  /** 存量统计 */
  count(): Promise<Result<number>>;
}