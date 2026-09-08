/**
 * L1 底座基础层: 审计日志 (audit)
 *
 * 记录敏感操作「谁在什么时候对什么做了什么」: 登录/改密/提权/删数据/改配置…
 * - 工厂 createMemoryAuditLog(): 内存环形缓冲 (默认保留 500 条), 供装配方直接 import
 * - 插件 @infrastructure/audit: append / query 两动作, 供其他装配走 ctx.call
 *
 * 内存环形缓冲适合框架层的通用实现; 需要持久化的装配 (如 appbase) 可把
 * append 事件镜像到自己的存储 (appbase 侧双写 PG audit_log 表)。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 类型与工厂 (直接 import 使用) ────────────────────────────────

export interface AuditEntry {
  /** ISO 时间戳 */
  at: string;
  /** 操作者 (邮箱/账号/IP) */
  actor: string;
  /** 动作 (如 user.reset_password / app.restore) */
  action: string;
  /** 操作对象 (如目标邮箱/应用名) */
  target?: string;
  /** 补充说明 */
  detail?: string;
}

export interface AuditQuery {
  limit?: number;
  /** 可选过滤: 按操作者或动作前缀 */
  actor?: string;
  actionPrefix?: string;
}

export interface MemoryAuditLog {
  append(entry: Omit<AuditEntry, "at">): AuditEntry;
  query(q?: AuditQuery): AuditEntry[];
  size(): number;
}

export function createMemoryAuditLog(keep = 500): MemoryAuditLog {
  const ring: AuditEntry[] = [];
  return {
    append(entry) {
      const full: AuditEntry = { ...entry, at: new Date().toISOString() };
      ring.push(full);
      if (ring.length > keep) ring.splice(0, ring.length - keep);
      return full;
    },
    query(q = {}) {
      let list = ring.slice().reverse(); // 新的在前
      if (q.actor) list = list.filter((e) => e.actor === q.actor);
      if (q.actionPrefix) list = list.filter((e) => e.action.startsWith(q.actionPrefix!));
      return list.slice(0, q.limit ?? 100);
    },
    size() {
      return ring.length;
    },
  };
}

// ── 服务定义 (插件形态, ctx.call 使用) ───────────────────────────

export interface AuditRequest {
  action: "append" | "query";
  /** append: 日志条目 (不含 at) */
  entry?: Omit<AuditEntry, "at">;
  /** query: 查询参数 */
  query?: AuditQuery;
}

export interface AuditResponse {
  /** append 返回写入的条目 */
  entry?: AuditEntry;
  /** query 返回结果 (新的在前) */
  entries?: AuditEntry[];
  total: number;
}

export const auditService: ServiceDefinition<AuditRequest, AuditResponse> = {
  id: "@infrastructure/audit",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "审计日志：敏感操作留痕 (谁/何时/对什么/做了什么)",
};

const sharedAudit = createMemoryAuditLog();

const auditProvider: Provider<AuditRequest, AuditResponse> = {
  service: auditService,
  name: "infrastructure-audit-memory",
  state: PluginState.Active,
  async execute(
    request: AuditRequest,
    _ctx: SeamContext,
  ): Promise<Result<AuditResponse>> {
    if (request.action === "append" && request.entry) {
      const entry = sharedAudit.append(request.entry);
      return ok({ entry, total: sharedAudit.size() });
    }
    const entries = sharedAudit.query(request.query);
    return ok({ entries, total: sharedAudit.size() });
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: `audit ring holds ${sharedAudit.size()} entries`, checkedAt: new Date().toISOString() };
  },
};

export { auditProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const auditManifest: PluginManifest = {
  name: "@infrastructure/audit",
  layer: LayerId.Infrastructure,
  description: "底座基础层：审计日志（内存环形缓冲）",
  version: "0.1.0",
  provides: [auditService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
