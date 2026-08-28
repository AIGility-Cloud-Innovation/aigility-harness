/**
 * @cognitive/timem-memory — harness Seam Provider (封装 dsh-plugin-timem 的 TimemClient)
 *
 * 让 workflow (Python py-bridge) 通过 Seam 回调调用 TiMEM 记忆管理。
 * 复用 dsh-plugin-timem 的 TimemClient (零 cordis 依赖, 纯 HTTP)。
 *
 * 提供服务:
 *   - @cognitive/timem-memory      只读检索 (回答前召回用户记忆)
 *   - @cognitive/timem-memory-write 记忆写入 (回答后保存问答)
 *
 * 均按 user_id + agent_id 隔离, 区分不同用户/不同 agent 的记忆。
 */

import { LayerId, PluginState, ok } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { TimemClient } from "@timem/dsh-plugin-timem";

// ── 检索请求/响应 ────────────────────────────────────────────────

export interface TimemMemorySearchRequest {
  /** 用户问题/查询 */
  query: string;
  /** 用户 ID (企微 userid 等) */
  user_id?: string | number;
  /** Agent 标识 (区分不同 agent) */
  agent_id?: string;
  /** 返回条数 */
  limit?: number;
}

export interface TimemMemorySearchResponse {
  results: Array<{ content: string; score?: number; memory_id?: string }>;
  total: number;
  ok: boolean;
  error?: string;
}

export const timemMemoryService: ServiceDefinition<
  TimemMemorySearchRequest,
  TimemMemorySearchResponse
> = {
  id: "@cognitive/timem-memory",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "TiMEM 记忆检索 (只读, 按 user_id+agent_id 隔离, 基于 dsh-plugin-timem TimemClient)",
};

// ── 写入请求/响应 ────────────────────────────────────────────────

export interface TimemMemoryWriteRequest {
  /** 要保存的内容 */
  content: string | Record<string, unknown>;
  /** 用户 ID */
  user_id?: string | number;
  /** Agent 标识 */
  agent_id?: string;
  /** 目标层 (默认 L1) */
  layer?: number;
}

export interface TimemMemoryWriteResponse {
  ok: boolean;
  task_id?: string;
  error?: string;
}

export const timemMemoryWriteService: ServiceDefinition<
  TimemMemoryWriteRequest,
  TimemMemoryWriteResponse
> = {
  id: "@cognitive/timem-memory-write",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "TiMEM 记忆写入 (回答后保存, 按 user_id+agent_id 隔离)",
};

// ── Provider 工厂 ────────────────────────────────────────────────

export function createTimemMemoryProvider(
  client: TimemClient,
): Provider<TimemMemorySearchRequest, TimemMemorySearchResponse> {
  return {
    service: timemMemoryService,
    name: "timem-memory-search",
    state: PluginState.Active,
    async execute(
      request: TimemMemorySearchRequest,
      _ctx: SeamContext,
    ): Promise<Result<TimemMemorySearchResponse>> {
      try {
        const data = await client.searchMemory({
          user_id: request.user_id ?? "anonymous",
          agent_id: request.agent_id,
          query: request.query,
          limit: request.limit ?? 5,
        });
        const memories = Array.isArray(data)
          ? data
          : ((data as { memories?: Array<{ content?: string; memory_id?: string; score?: number }> })
              ?.memories ?? []);
        const results = memories
          .filter((m) => typeof m === "object" && m !== null)
          .map((m) => ({
            content: m.content ?? "",
            score: m.score,
            memory_id: m.memory_id,
          }));
        const total =
          typeof data === "object" && data !== null && "total" in data
            ? Number((data as { total?: number }).total ?? results.length)
            : results.length;
        return ok({ results, total, ok: true });
      } catch (e) {
        return ok({
          results: [],
          total: 0,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    async health(): Promise<HealthStatus> {
      return {
        healthy: true,
        detail: "timem-memory search ready",
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

export function createTimemMemoryWriteProvider(
  client: TimemClient,
): Provider<TimemMemoryWriteRequest, TimemMemoryWriteResponse> {
  return {
    service: timemMemoryWriteService,
    name: "timem-memory-write",
    state: PluginState.Active,
    async execute(
      request: TimemMemoryWriteRequest,
      _ctx: SeamContext,
    ): Promise<Result<TimemMemoryWriteResponse>> {
      try {
        const data = await client.addMemory({
          user_id: request.user_id ?? "anonymous",
          agent_id: request.agent_id,
          content: request.content,
          layer: request.layer ?? 1,
        });
        return ok({
          ok: true,
          task_id: (data as { task_id?: string })?.task_id,
        });
      } catch (e) {
        return ok({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    async health(): Promise<HealthStatus> {
      return {
        healthy: true,
        detail: "timem-memory write ready",
        checkedAt: new Date().toISOString(),
      };
    },
  };
}