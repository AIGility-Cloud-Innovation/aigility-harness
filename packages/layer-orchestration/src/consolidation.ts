/**
 * L4 编排层: consolidation — 汇总收敛 (E4)
 *
 * 一次 LLM 调用完成四件事: 去重 / 关联 / 冲突 / 排序。
 * 输出强校验 JSON (借鉴 timem-project planner 的 validatePlan 模式:
 * 非法输出由调用方重试一次), 拓扑排序在本模块用 Kahn 算法做,
 * 环检测失败回退 LLM 给定顺序并标注 orderIsFallback。
 */
import { randomUUID } from "node:crypto";
import type { Consolidation, ConsolidationItem, Requirement } from "./requirement-store.js";

// ---- 汇总 prompt (E4 表格的四件事) ----

export const CONSOLIDATION_SYSTEM_PROMPT = `你是需求汇总器。用户在聊天中陆续提出了若干条需求，现在沟通结束，需要你把全部需求综合分析。

你必须依次完成四件事：
① 去重：语义相同或互为子集的需求合并为一个任务项，写明 merged_reason；任何原始需求都不允许被丢弃，必须至少归属一个任务项。
② 关联：有耦合的需求（如「深色模式」和「图表也变色」）合并设计，在 task_description 中体现统一做法。
③ 冲突：互相矛盾或争抢同一实现面的，不要擅自取舍，标记 blocked_by_conflict 并在说明里给出两个可选方案。
④ 排序：输出 depends_on 依赖数组（引用任务项下标）；无依赖的按「风险小→风险大」排（先做容易的，早失败早暴露）。

另外：某任务缺少必要信息的，把问题列进 missing_information（会变成对用户的反问）。
一条原始需求若包含多个独立事项，可拆分为多个任务项（每个任务项都引用该条 requirement_id）。

只输出 JSON，不要输出任何其他内容：
{"items": [{
  "requirement_ids": ["req_xxx"],
  "task_title": "string",
  "task_description": "给执行引擎的完整任务描述",
  "merged_reason": "string | 可省略",
  "depends_on": [0],
  "blocked_by_conflict": "string | 可省略",
  "missing_information": ["string"] | 可省略,
  "acceptance_criteria": ["验收标准"]
}],
 "design_doc": "统一设计方案 markdown：全局视角说明这些任务共同构成什么、整体架构/风格约定、执行顺序及理由"}`;

// ---- LLM 原始输出 → 强校验 ConsolidationItem ----

/** 宽松抽取: 容忍 ```json 围栏与前后杂文 */
function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseConsolidation(
  raw: string,
  openRequirements: Requirement[],
): { items: ConsolidationItem[]; designDoc: string } | null {
  const parsed = extractJson(raw) as { items?: unknown[]; design_doc?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;

  const knownIds = new Set(openRequirements.map((r) => r.id));
  const items: ConsolidationItem[] = [];

  for (const [i, raw] of parsed.items.entries()) {
    if (typeof raw !== "object" || raw === null) return null;
    const it = raw as Record<string, unknown>;
    if (typeof it["task_title"] !== "string" || !it["task_title"]) return null;
    if (typeof it["task_description"] !== "string" || !it["task_description"]) return null;
    const reqIds = Array.isArray(it["requirement_ids"]) ? it["requirement_ids"] : [];
    if (reqIds.length === 0 || reqIds.some((id) => typeof id !== "string" || !knownIds.has(id as string))) {
      return null;
    }
    // depends_on 只允许引用其他下标, 不允许自依赖
    const deps = Array.isArray(it["depends_on"])
      ? it["depends_on"].filter(
          (d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d < parsed.items!.length && d !== i,
        )
      : [];
    items.push({
      requirementIds: reqIds as string[],
      taskTitle: it["task_title"],
      taskDescription: it["task_description"],
      mergedReason: typeof it["merged_reason"] === "string" ? it["merged_reason"] : undefined,
      dependsOn: deps as number[],
      blockedByConflict: typeof it["blocked_by_conflict"] === "string" ? it["blocked_by_conflict"] : undefined,
      missingInformation: Array.isArray(it["missing_information"])
        ? it["missing_information"].filter((m): m is string => typeof m === "string")
        : undefined,
      acceptanceCriteria: Array.isArray(it["acceptance_criteria"])
        ? it["acceptance_criteria"].filter((a): a is string => typeof a === "string")
        : [],
    });
  }

  // 全覆盖校验: 每条 open 需求必须被至少一个 item 引用 (不允许 LLM 静默丢弃)
  const covered = new Set(items.flatMap((it) => it.requirementIds));
  for (const r of openRequirements) {
    if (!covered.has(r.id)) return null;
  }

  return {
    items,
    designDoc: typeof parsed.design_doc === "string" ? parsed.design_doc : "",
  };
}

// ---- 拓扑排序 (Kahn) ----

/** 返回排序后的下标序列; 有环时返回 null */
export function topoSort(items: ConsolidationItem[]): number[] | null {
  const n = items.length;
  const indegree = new Array<number>(n).fill(0);
  const dependents = new Map<number, number[]>();
  for (const [i, it] of items.entries()) {
    for (const dep of it.dependsOn) {
      indegree[i]++;
      const list = dependents.get(dep) ?? [];
      list.push(i);
      dependents.set(dep, list);
    }
  }
  // 风险小→风险大: 同层按 LLM 给定顺序 (稳定)
  const queue = indegree.map((d, i) => [d, i] as const)
    .filter(([d]) => d === 0)
    .map(([, i]) => i);
  const order: number[] = [];
  while (queue.length > 0) {
    const i = queue.shift()!;
    order.push(i);
    for (const next of dependents.get(i) ?? []) {
      indegree[next]--;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  return order.length === n ? order : null;
}

// ---- 组装汇总单 ----

export function buildConsolidation(
  sessionId: string,
  items: ConsolidationItem[],
  designDoc: string,
  version: number,
): Consolidation {
  const sorted = topoSort(items);
  return {
    id: `cons_${randomUUID().slice(0, 8)}`,
    sessionId,
    version,
    items,
    designDoc,
    createdAt: Date.now(),
    executionOrder: sorted ?? items.map((_, i) => i),
    orderIsFallback: sorted === null,
  };
}

// ---- 汇总单渲染 (确认消息文本) ----

export function renderConsolidation(c: Consolidation): string {
  const lines: string[] = [`📋 需求汇总单 v${c.version}（共 ${c.items.length} 个任务）`, ""];
  c.executionOrder.forEach((idx, position) => {
    const it = c.items[idx]!;
    lines.push(`${position + 1}. ${it.taskTitle}`);
    if (it.mergedReason) lines.push(`   （合并：${it.mergedReason}）`);
    if (it.dependsOn.length > 0) {
      const names = it.dependsOn.map((d) => c.items[d]?.taskTitle ?? `#${d}`).join("、");
      lines.push(`   （依赖：${names}）`);
    }
    if (it.blockedByConflict) lines.push(`   ⚠ 冲突待拍板：${it.blockedByConflict}`);
    if (it.missingInformation && it.missingInformation.length > 0) {
      lines.push(`   ❓ 缺信息：${it.missingInformation.join("；")}`);
    }
  });
  if (c.orderIsFallback) lines.push("", "（注：任务间存在循环依赖，已按原顺序排列，请人工确认顺序）");
  lines.push("", "回复「确认」开始按序执行；补充需求我会重新汇总。");
  return lines.join("\n");
}
