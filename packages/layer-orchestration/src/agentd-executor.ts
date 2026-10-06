/**
 * agentd-executor — AgentdProvider 实施半边（D 组任务 → agentd 派发 → 终态轮询）
 *
 * 把旧链路 dispatchIssue 的派发域平移进 TaskProvider 契约：
 *   dispatch(task) = 去重 → create-from-message → confirm-project → confirm-prompt
 *                    （15 分钟确认闸门在 agentd 侧，scheduleLoop 自动跑）
 *   poll(taskId)   = 轮询 agentd 任务状态 → 统一状态映射
 *
 * 与旧链路的差异（均为刻意）：
 *   · 台账 claim 前置：ready → dispatched 原子领取（改派保护在 claim 内）；
 *   · 提示词以任务描述为准（现状/目标/补充材料都在），工单正文可选注入；
 *   · 飞书/Gitea 回写不在本模块（投影层负责），本模块只管台账与 agentd。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { err, ok } from "@aigility-harness/core";
import type { Result, TaskRecord, ExecutionHandle } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";
import {
  createFromMessage,
  confirmProject,
  confirmPrompt,
  listProjects,
  registerProject,
  listTasks,
  defaultSocketPath,
  defaultToken,
} from "./agentd-client.js";
import type { AgentdEndpoint, AgentdTask, CreateFromMessageResult } from "./agentd-client.js";

export const AGENTD_EXECUTOR_ID = "agentd-task";

export interface AgentdExecutorOptions {
  registry: TaskRegistry;
  /** 确认闸门 ms（缺省 env TIMEM_DISPATCH_CONFIRM_MS，再退 15 分钟） */
  delayMs?: number;
  /** agentd UDS 覆盖（缺省 defaultSocketPath/defaultToken） */
  socketPath?: string;
  token?: string;
  /** 工单正文抓取（可选）：给出则派发提示词带工单正文 */
  fetchIssueBody?: (repo: string, n: number) => Promise<string | undefined>;
}

function ep(o: AgentdExecutorOptions): AgentdEndpoint {
  return { socketPath: o.socketPath ?? defaultSocketPath(), token: o.token ?? defaultToken() };
}

export function dispatchDelayMs(): number {
  const env = Number(process.env["TIMEM_DISPATCH_CONFIRM_MS"]);
  return Number.isFinite(env) && env >= 0 ? env : 15 * 60_000;
}

/** 工单引用拆解："org/repo#N" → { repo, n }；不符返回 undefined */
export function splitIssueRef(ref: string | undefined): { repo: string; n: number } | undefined {
  const m = ref?.match(/^([^\s#/]+\/[^\s#]+)#(\d+)$/);
  return m ? { repo: m[1], n: Number(m[2]) } : undefined;
}

/** 记录的工单引用：links 优先，退回标题 [org/repo#N] 前缀 */
function issueRefOf(task: TaskRecord): { repo: string; n: number } | undefined {
  return splitIssueRef(task.links?.["gitea-issue"]?.guid) ?? splitIssueRef(task.title);
}

/** agentd 活跃任务里是否已有该工单派生任务（sourceMessageId=issue:{repo}#{n} 约定） */
async function hasActiveForIssue(endpoint: AgentdEndpoint, repo: string, n: number): Promise<AgentdTask | undefined> {
  const marker = `issue:${repo}#${n}`;
  const tasks = await listTasks(endpoint).catch(() => [] as AgentdTask[]);
  return tasks.find(
    (t) => (t.sourceMessageId ?? "") === marker && ["pending_confirm", "pending_project", "queued", "running", "needs_review"].includes(t.status ?? ""),
  );
}

/** 项目自动注册：agentd 已注册则复用；本地 ~/AI/<短名> 存在则注册；否则 undefined */
async function ensureProjectRegistered(endpoint: AgentdEndpoint, repo: string): Promise<string | undefined> {
  const shortName = repo.split("/")[1] ?? repo;
  const projects = await listProjects(endpoint).catch(() => [] as Array<{ id?: string; name?: string }>);
  const hit = projects.find((p) => p.id === shortName || p.name === shortName);
  if (hit?.id) return hit.id;
  const localRoot = resolve(join(homedir(), "AI", shortName));
  if (!existsSync(localRoot)) return undefined;
  const reg = await registerProject(endpoint, { id: shortName, name: shortName, rootPaths: [localRoot], available: true }).catch(
    (e: Error) => e,
  );
  if (reg instanceof Error || !reg.id) return undefined;
  return reg.id ?? shortName;
}

export interface AgentdDispatchResult {
  ok: boolean;
  detail: string;
  handle?: ExecutionHandle;
}

/** 派发核心（对齐旧 dispatchIssue 语义）：去重 → 建任务 → 项目归属 → 确认闸门 → 台账 claim */
export async function dispatchToAgentd(
  o: AgentdExecutorOptions,
  task: TaskRecord,
  fetchIssueBody: ((repo: string, n: number) => Promise<string | undefined>) | undefined,
): Promise<AgentdDispatchResult> {
  const issue = issueRefOf(task);
  if (!issue) return { ok: false, detail: "缺少工单引用（links.gitea-issue 或标题 [org/repo#N]）" };
  const { repo, n } = issue;
  const endpoint = ep(o);

  // ① agentd 去重：同工单已有活跃任务则不重复派发
  const active = await hasActiveForIssue(endpoint, repo, n);
  if (active) {
    return { ok: false, detail: `工单 #${n} 已有进行中的执行任务（${active.status ?? "?"}），不重复派发。` };
  }

  // ② 建任务（sourceMessageId=issue:{repo}#{n}，确定性映射防重）
  let bodyText = "";
  try {
    bodyText = (await fetchIssueBody?.(repo, n)) ?? "";
  } catch {
    bodyText = "";
  }
  const prompt = [
    `请完成 ${repo} 工单 #${n}：${task.title}`,
    bodyText ? `工单正文：\n${bodyText.trim()}` : "",
    task.description?.trim() ? `任务上下文：\n${task.description.trim()}` : "",
    `\n完成后按项目惯例提交（commit 信息引用工单号 #${n}）。`,
  ]
    .filter(Boolean)
    .join("\n");
  const created = await createFromMessage(endpoint, {
    source: "harness-dispatch",
    sourceMessageId: `issue:${repo}#${n}`,
    sourceConversationId: "",
    title: `#${n} ${task.title}`.slice(0, 80),
    description: prompt,
    text: prompt,
  });
  const taskId = created.id ?? created.taskId ?? "";
  if (!taskId) return { ok: false, detail: "agentd 未返回任务 ID（执行引擎未就绪或参数被拒）" };

  // ③ 项目归属闸门：identify 已解析则自动确认（高置信建单即带 projectId）
  let status = created.status ?? "";
  if (created.pending_project || status === "pending_project") {
    const projectId = await ensureProjectRegistered(endpoint, repo);
    if (!projectId) {
      return {
        ok: false,
        detail: `工单 #${n} 的执行任务待确认项目归属（agentd 任务 ${taskId}）。本地无 ~/AI/${repo.split("/")[1] ?? repo} 目录且 agentd 未注册该项目，请先克隆或手工注册。`,
      };
    }
    const confirmedP = await confirmProject(endpoint, taskId, projectId).catch((e: Error) => e);
    if (confirmedP instanceof Error) {
      return { ok: false, detail: `工单 #${n} 项目归属确认失败（${confirmedP.message}），agentd 任务 ${taskId}` };
    }
    status = (confirmedP as CreateFromMessageResult).status ?? "pending_confirm";
  }

  // ④ 确认闸门：pending_confirm → queued + delayMs 定时（agentd scheduleLoop 自动跑）
  if (status === "pending_confirm") {
    const confirmed = await confirmPrompt(endpoint, taskId, { delayMs: dispatchDelayMs() });
    status = confirmed.status ?? "queued";
  }

  // ⑤ 台账 claim：ready → dispatched 原子领取（改派保护在 claim 内）
  const claim = o.registry.claim(task.uid, AGENTD_EXECUTOR_ID, taskId, "ready");
  if (!claim.ok) return { ok: false, detail: claim.error };

  const mins = Math.round(dispatchDelayMs() / 60_000);
  return {
    ok: true,
    detail: `已派发 code agent：确认闸门 ${mins} 分钟内可撤销，超时自动执行（agentd 任务 ${taskId}）`,
    handle: { uid: task.uid, provider: AGENTD_EXECUTOR_ID, handle: taskId },
  };
}

/** 终态轮询：agentd 任务当前状态 + 统一映射（调用方决定是否写回台账/投影） */
export async function pollAgentdTask(
  endpoint: AgentdEndpoint,
  taskId: string,
): Promise<{ status?: string; lastError?: string } | undefined> {
  const tasks = await listTasks(endpoint).catch(() => [] as AgentdTask[]);
  return tasks.find((t) => t.id === taskId);
}

/** 契约实现（execute + sync 就绪态；collect 不重复——收集半边已实现） */
export function createAgentdExecutor(o: AgentdExecutorOptions): {
  dispatch(task: TaskRecord, fetchIssueBody?: (repo: string, n: number) => Promise<string | undefined>): Promise<AgentdDispatchResult>;
  endpoint: AgentdEndpoint;
} {
  return {
    dispatch: (task, fetchIssueBody) => dispatchToAgentd(o, task, fetchIssueBody),
    endpoint: ep(o),
  };
}
