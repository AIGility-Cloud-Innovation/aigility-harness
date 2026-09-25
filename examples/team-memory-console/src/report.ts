/**
 * 日报生成 — 抓取指定日期各成员产生的记忆, 按人分组生成文本摘要
 *
 * 策略: 对每个成员用多组关键词查询 → 按 created_at 过滤出目标日期 →
 *       按 memory_id 去重 → 每人一组条目。摘要是确定性拼接 (无 LLM),
 *       由定时任务直接推送; 若在 DSH 会话内调用, Agent 可再对其二次润色。
 */

import type { TeamMemoryService } from "./service.js";
import type { AttributedMemory } from "./service.js";

const QUERY_SETS = [
  "最近 工作 进展 项目",
  "计划 问题 部署 完成",
  "讨论 决定 方案 需求",
];

/** 晨报(今日计划)专用: 面向计划/待办/未完成语义的查询组 */
const PLAN_QUERY_SETS = [
  "明天 接下来 待办 计划",
  "计划 排期 下一步 要做",
  "未完成 问题 继续 需要",
  "今天 任务 优先 安排",
];

/** 晨报召回窗口: 只看 date 往前 windowDays 天内产生的记忆 (本地时区) */
const PLAN_WINDOW_DAYS = 3;

export interface MemberReport {
  member: { member_id: string; name: string };
  memories: AttributedMemory[];
  errors: string[];
}

export interface DayReport {
  date: string; // YYYY-MM-DD
  members: MemberReport[];
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveDate(offset: "today" | "yesterday" | string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(offset)) return offset;
  const d = new Date();
  if (offset === "yesterday") d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function isOnDate(item: AttributedMemory, date: string): boolean {
  const raw = item.created_at ?? "";
  if (!raw) return false;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return raw.startsWith(date);
  // created_at 可能是 UTC, 按本地时区归日
  return localDateStr(t) === date;
}

function localDateToDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** 记忆是否产生于 [date-windowDays+1, date] 的本地日期窗口内 */
function isWithinWindow(item: AttributedMemory, date: string, windowDays = PLAN_WINDOW_DAYS): boolean {
  const raw = item.created_at ?? "";
  if (!raw) return false;
  const t = new Date(raw);
  const day = Number.isNaN(t.getTime()) ? null : localDateStr(t);
  if (!day) return raw.startsWith(date);
  const from = localDateToDate(date);
  from.setDate(from.getDate() - (windowDays - 1));
  const to = localDateToDate(date);
  to.setDate(to.getDate() + 1); // 含 date 当天全天
  const cur = localDateToDate(day);
  return cur >= from && cur < to;
}

/** 生成某天晨报候选 (全员): 面向"今天可能要完成什么"的计划类记忆, 近 3 天窗口 */
export async function buildDayPlan(svc: TeamMemoryService, date: string): Promise<DayReport> {
  const members: MemberReport[] = [];
  for (const m of svc.registry.members) {
    const found = new Map<string, AttributedMemory>();
    const errors: string[] = [];
    // 计划语义组 + 当日锚定, 翻页加深召回 (同日报策略)
    const queries = [...PLAN_QUERY_SETS, `${date} 计划 要做 今天`];
    for (const uid of m.timem_user_ids) {
      for (const q of queries) {
        try {
          const res = await svc.query(uid, q, 20, 2);
          for (const it of res.memories) {
            if (isWithinWindow(it, date) && it.memory_id && !found.has(it.memory_id)) found.set(it.memory_id, it);
          }
        } catch (e) {
          errors.push(`${uid} «${q}»: ${(e as Error).message}`);
        }
      }
    }
    members.push({
      member: { member_id: m.member_id, name: m.name },
      memories: [...found.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
      errors,
    });
  }
  return { date, members };
}

/** 生成某天日报 (全员) */
export async function buildDayReport(svc: TeamMemoryService, date: string): Promise<DayReport> {
  const members: MemberReport[] = [];
  for (const m of svc.registry.members) {
    const found = new Map<string, AttributedMemory>();
    const errors: string[] = [];
    // 通用关键词组 + 日期锚定查询: 语义检索按相关度排序、与日期无关,
    // 直接拿日期字符串去匹配 (当日记忆内容通常带日期), 召回远比纯通用词稳
    const queries = [...QUERY_SETS, `${date} 完成 问题 部署`, date];
    for (const uid of m.timem_user_ids) {
      for (const q of queries) {
        try {
          const res = await svc.query(uid, q, 20, 2);
          for (const it of res.memories) {
            if (isOnDate(it, date) && it.memory_id && !found.has(it.memory_id)) found.set(it.memory_id, it);
          }
        } catch (e) {
          errors.push(`${uid} «${q}»: ${(e as Error).message}`);
        }
      }
    }
    members.push({
      member: { member_id: m.member_id, name: m.name },
      memories: [...found.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
      errors,
    });
  }
  return { date, members };
}

/** 渲染为飞书文本 */
export function renderReport(r: DayReport): string {
  const lines: string[] = [`📋 团队记忆日报 · ${r.date}`];
  let total = 0;
  for (const m of r.members) total += m.memories.length;
  lines.push(`共 ${total} 条新记忆, ${r.members.filter((x) => x.memories.length).length} 人有活动\n`);
  for (const m of r.members) {
    lines.push(`—— ${m.member.name} (${m.memories.length} 条) ——`);
    if (!m.memories.length) {
      lines.push("  (当天无新记忆)");
    } else {
      m.memories.forEach((it, i) => {
        const time = (it.created_at ?? "").slice(11, 16);
        const text = (it.content ?? "").replace(/\s+/g, " ").slice(0, 120);
        lines.push(`${i + 1}. [${time}] ${text}${(it.content ?? "").length > 120 ? "…" : ""}`);
      });
    }
    m.errors.forEach((e) => lines.push(`  ⚠ ${e.slice(0, 100)}`));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
