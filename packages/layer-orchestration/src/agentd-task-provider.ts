/**
 * L4 编排层: agentd-task-provider — 实施 provider 的收集半边
 * （agentd 存量任务 → 登记表候选；execute/sync 随派发接线补齐）
 *
 * 让登记表看见已在执行侧存在的任务（老链路 create-from-message 建的、
 * 人工在 timem-project 看板建的），避免统一视图缺执行中任务。
 *
 * 关联恢复：agentd 任务的 sourceMessageId 若是 "issue:{repo}#{n}"（派发域
 * 约定），候选带 related["gitea-issue"]={guid:"{repo}#{n}"}——登记表收编时
 * 自动把 agentd 任务和工单挂到同一条记录上，跨源 JOIN 零存储。
 */
import type { CollectTaskInput, ExternalHandle, TaskCursor, TaskProvider, UnifiedStatus } from "@aigility-harness/core";

export const AGENTD_TASK_PROVIDER_ID = "agentd-task";

/** agentd 原生状态 → 统一状态（agentd 九态是统一状态机的超集来源） */
export const AGENTD_STATUS_TO_UNIFIED: Record<string, UnifiedStatus> = {
  pending_confirmation: "dispatched",
  pending_confirm: "dispatched",
  pending_project: "dispatched",
  queued: "dispatched",
  running: "running",
  needs_review: "review",
  completed: "done",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

/** agentd 任务的最小形状（对齐 agentd-client.AgentdTask 的读取域字段） */
export interface AgentdTaskLike {
  id?: string;
  status?: string;
  title?: string;
  projectId?: string;
  sourceMessageId?: string;
}

/** 注入的 agentd 列表读取（生产：listTasks(defaultEndpoint())；测试：假桩） */
export type AgentdTaskList = () => Promise<AgentdTaskLike[]>;

/** "issue:{repo}#{n}" → 工单句柄 {repo}#{n}；非工单派生返回 undefined */
export function issueHandleFromSource(sourceMessageId: string | undefined): ExternalHandle | undefined {
  const m = sourceMessageId?.match(/^issue:(.+)$/);
  return m ? { guid: m[1] } : undefined;
}

export async function* sweepAgentdTasks(
  list: AgentdTaskList,
  cursor?: TaskCursor,
): AsyncGenerator<CollectTaskInput> {
  // agentd listTasks 无分页/游标语义（UDS 单进程内存态），游标仅作 provider 停车场
  void cursor;
  let tasks: AgentdTaskLike[];
  try {
    tasks = await list();
  } catch (e) {
    console.error(`[agentd-task-provider] listTasks failed: ${String(e)}`);
    return;
  }
  for (const t of tasks) {
    if (!t.id) continue;
    const issueHandle = issueHandleFromSource(t.sourceMessageId);
    yield {
      title: t.title?.trim() || t.id,
      status: AGENTD_STATUS_TO_UNIFIED[t.status ?? ""] ?? "dispatched",
      origin: { provider: AGENTD_TASK_PROVIDER_ID, guid: t.id },
      projectRef: t.projectId || issueHandle?.guid.split("#")[0],
      ...(issueHandle ? { related: { "gitea-issue": issueHandle } } : {}),
    };
  }
}

export async function collectAgentdTasks(list: AgentdTaskList, cursor?: TaskCursor): Promise<CollectTaskInput[]> {
  const out: CollectTaskInput[] = [];
  for await (const c of sweepAgentdTasks(list, cursor)) out.push(c);
  return out;
}

/** 契约实现（收集半边；execute/sync 随派发接线补齐） */
export function createAgentdTaskProvider(list: AgentdTaskList): TaskProvider {
  return {
    id: AGENTD_TASK_PROVIDER_ID,
    capabilities: { collect: true, execute: false },
    mapStatus: (native: string) => AGENTD_STATUS_TO_UNIFIED[native],
    collect: (cursor?: TaskCursor) => sweepAgentdTasks(list, cursor),
  };
}
