/**
 * @action/timem-memory — harness Seam Provider (封装 dsh-plugin-timem 的 TimemClient)
 *
 * 让 workflow (Python py-bridge) 通过 Seam 回调调用 TiMEM 记忆管理。
 * 复用 dsh-plugin-timem 的 TimemClient (零 cordis 依赖, 纯 HTTP)。
 *
 * 提供服务:
 *   - @action/timem-memory       只读检索 (回答前召回用户记忆)
 *   - @action/timem-memory-write  记忆写入 (回答后保存问答)
 *   - @action/timem-rule-recall   经验规则召回 (回答前召回可复用经验, RSI 读半边)
 *   - @action/timem-rule-create   经验规则沉淀 (确认的教训/约定固化为规则, RSI 写半边)
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
  /** 域标签 (如项目 id; 项目小助理按项目聚合记忆时使用) */
  domain?: string;
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
  id: "@action/timem-memory",
  version: "1.0.0",
  layer: LayerId.Action,
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
  /** 域标签 (如项目 id) */
  domain?: string;
  /** 目标层 (默认 L2) */
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
  id: "@action/timem-memory-write",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "TiMEM 记忆写入 (回答后保存, 按 user_id+agent_id 隔离)",
};

// ── Provider 工厂 ────────────────────────────────────────────────

/** 最小客户端契约 (结构化类型, 便于装配方注入带兼容层/热更新能力的客户端实现) */
export interface TimemMemoryClientLike {
  searchMemory(req: TimemMemorySearchRequest): Promise<unknown>;
  addMemory(req: TimemMemoryWriteRequest & { layer?: number }): Promise<unknown>;
  /** 经验规则召回 (dsh-plugin-timem ≥ recallRules 端点); 可选——旧客户端注入后规则服务降级 ok:false */
  recallRules?(req: {
    query_text?: string;
    user_id?: string | number;
    agent_id?: string;
    mode?: "similarity" | "judged" | "auto";
    top_k?: number;
  }): Promise<unknown>;
  /** 经验规则创建 (dsh-plugin-timem createRule); 可选, 同上 */
  createRule?(req: {
    name: string;
    situation: string;
    lesson: string;
    user_id?: string | number;
    agent_id?: string;
    trigger_tags?: string[];
  }): Promise<unknown>;
}

export function createTimemMemoryProvider(
  client: TimemMemoryClientLike,
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
          domain: request.domain,
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
  client: TimemMemoryClientLike,
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
          domain: request.domain,
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

// ── 经验规则：召回（RSI 读半边） ─────────────────────────────────

export interface TimemRuleRecallRequest {
  /** 召回查询（通常= 用户原话/当前场景描述） */
  query: string;
  /** 适用性判断的场景文本（judged/auto 模式用；缺省与 query 相同） */
  judge_scene_text?: string;
  user_id?: string | number;
  agent_id?: string;
  /** 召回模式：similarity 纯向量 / judged 逐条 LLM 判断 / auto 服务端自选（默认） */
  mode?: "similarity" | "judged" | "auto";
  /** 最多召回条数（1-50，默认 3） */
  top_k?: number;
}

export interface TimemRuleRecallResponse {
  rules: Array<{
    rule_id?: string;
    name?: string;
    situation?: string;
    lesson: string;
    score?: number;
  }>;
  total: number;
  ok: boolean;
  error?: string;
}

export const timemRuleRecallService: ServiceDefinition<
  TimemRuleRecallRequest,
  TimemRuleRecallResponse
> = {
  id: "@action/timem-rule-recall",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "TiMEM 经验规则召回 (只读, 回答前召回可复用经验注入提示词; 客户端不支持规则端点时降级 ok:false)",
};

export function createTimemRuleRecallProvider(
  client: TimemMemoryClientLike,
): Provider<TimemRuleRecallRequest, TimemRuleRecallResponse> {
  return {
    service: timemRuleRecallService,
    name: "timem-rule-recall",
    state: PluginState.Active,
    async execute(
      request: TimemRuleRecallRequest,
      _ctx: SeamContext,
    ): Promise<Result<TimemRuleRecallResponse>> {
      if (typeof client.recallRules !== "function") {
        return ok({ rules: [], total: 0, ok: false, error: "客户端不支持规则端点" });
      }
      try {
        const data = await client.recallRules({
          query_text: request.query,
          user_id: request.user_id ?? "anonymous",
          agent_id: request.agent_id,
          mode: request.mode,
          top_k: request.top_k ?? 3,
        });
        const rules = (Array.isArray(data) ? data : [])
          .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
          .map((r) => ({
            rule_id: r.rule_id as string | undefined,
            name: r.name as string | undefined,
            situation: r.situation as string | undefined,
            lesson: (r.lesson ?? "") as string,
            score: r.score as number | undefined,
          }))
          .filter((r) => r.lesson);
        return ok({ rules, total: rules.length, ok: true });
      } catch (e) {
        return ok({
          rules: [],
          total: 0,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    async health(): Promise<HealthStatus> {
      return {
        healthy: true,
        detail: "timem-rule recall ready",
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

// ── 经验规则：沉淀（RSI 写半边） ─────────────────────────────────

export interface TimemRuleCreateRequest {
  /** 规则名（1-128 字符，短语概括） */
  name: string;
  /** 产生经验的情境（1-4000 字符） */
  situation: string;
  /** 经验内容（1-4000 字符） */
  lesson: string;
  user_id?: string | number;
  agent_id?: string;
  trigger_tags?: string[];
}

export interface TimemRuleCreateResponse {
  ok: boolean;
  rule_id?: string;
  error?: string;
}

export const timemRuleCreateService: ServiceDefinition<
  TimemRuleCreateRequest,
  TimemRuleCreateResponse
> = {
  id: "@action/timem-rule-create",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "TiMEM 经验规则创建 (把确认的教训/约定固化为可召回规则; 客户端不支持规则端点时降级 ok:false)",
};

export function createTimemRuleCreateProvider(
  client: TimemMemoryClientLike,
): Provider<TimemRuleCreateRequest, TimemRuleCreateResponse> {
  return {
    service: timemRuleCreateService,
    name: "timem-rule-create",
    state: PluginState.Active,
    async execute(
      request: TimemRuleCreateRequest,
      _ctx: SeamContext,
    ): Promise<Result<TimemRuleCreateResponse>> {
      if (typeof client.createRule !== "function") {
        return ok({ ok: false, error: "客户端不支持规则端点" });
      }
      try {
        const data = (await client.createRule({
          name: request.name,
          situation: request.situation,
          lesson: request.lesson,
          user_id: request.user_id ?? "anonymous",
          agent_id: request.agent_id,
          trigger_tags: request.trigger_tags,
        })) as { rule_id?: string };
        return ok({ ok: true, rule_id: data?.rule_id });
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
        detail: "timem-rule create ready",
        checkedAt: new Date().toISOString(),
      };
    },
  };
}