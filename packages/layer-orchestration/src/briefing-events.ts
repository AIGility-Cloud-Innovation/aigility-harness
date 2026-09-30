/**
 * briefing 活动事件 — task-issue-sync / task-pipeline 通知「项目有值得记住的变化」
 *
 * 解耦设计：编排域各处只调用本模块的 notifyRepoActivity（零依赖、同步返回）；
 * 装配层（feishu-task-loop）用 setBriefingActivitySink 注册真正的快照写入函数
 * （拿到 kernel ctx 后才能调 provider）。节流在本模块做：同一项目 10 分钟内
 * 只触发一次事件快照（前沿触发），避免刷屏 timem。
 */

import { findProjectByRepo, getProjectRegistry, type ProjectEntry } from "./project-registry.js";

export type BriefingActivitySink = (projectId: string, hint: string) => void;

let sink: BriefingActivitySink | undefined;

/** 装配层注册事件快照写入函数（重复注册以最后一次为准） */
export function setBriefingActivitySink(fn: BriefingActivitySink | undefined): void {
  sink = fn;
}

/** 同一项目键两次事件快照的最小间隔（默认 10 分钟） */
export const ACTIVITY_THROTTLE_MS = 10 * 60_000;

const lastFiredAt = new Map<string, number>();

/** 仓库 → 项目 → 触发事件快照；未登记仓库回退 org:<组织> 键 */
export function notifyRepoActivity(repoFullName: string, hint: string): void {
  if (!sink) return;
  const project: ProjectEntry | undefined = findProjectByRepo(getProjectRegistry(), repoFullName);
  const key = project?.project_id ?? `org:${repoFullName.split("/")[0] ?? repoFullName}`;
  notifyProjectActivity(key, hint);
}

/** 直接按项目键触发事件快照（同一项目键 10 分钟节流，前沿触发） */
export function notifyProjectActivity(projectKey: string, hint: string): void {
  if (!sink) return;
  const now = Date.now();
  if (now - (lastFiredAt.get(projectKey) ?? 0) < ACTIVITY_THROTTLE_MS) return;
  lastFiredAt.set(projectKey, now);
  try {
    sink?.(projectKey, hint);
  } catch (e) {
    console.error(`[briefing-events] 事件快照失败: ${String(e)}`);
  }
}

/** 仅供测试：清空节流状态与 sink */
export function resetBriefingActivityForTest(): void {
  lastFiredAt.clear();
  sink = undefined;
}
