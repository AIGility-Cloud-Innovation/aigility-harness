/**
 * 日报生成 — 抓取指定日期各成员产生的记忆, 按人分组生成文本摘要
 *
 * 策略: 对每个成员用多组关键词查询 → 按 created_at 过滤出目标日期 →
 *       按 memory_id 去重 → 每人一组条目。摘要是确定性拼接 (无 LLM),
 *       由定时任务直接推送; 若在 DSH 会话内调用, Agent 可再对其二次润色。
 *
 * 2026-10-07 修复: 检索侧原先硬编码 level:2 丢弃了 L1 原始层 (当日记忆最丰富的一层)。
 *   现在全层检索 (L1+L2+L3), 并在每人小标题上给出层分布, 便于核对"是否真拉全"。
 *   查询组也从 3 组泛词扩到覆盖当日真实话题的探针组 —— 泛词与当日话题系统性不相交。
 */

import type { TeamMemoryService } from "./service.js";
import type { AttributedMemory } from "./service.js";

/** 通用话题组 (覆盖当日实际工作主题, 而非"最近/工作/进展"这类系统性打不中的空泛词) */
const QUERY_SETS = [
  "最近 工作 进展 项目",
  "计划 问题 部署 完成",
  "讨论 决定 方案 需求",
  "修复 测试 bug 上线",
  "任务 看板 工单",
  "会议 沟通 安排",
  "完成 提交 代码",
  "遇到 问题 阻塞",
  "架构 设计 文档",
  "定价 毛利率 额度 计费",
  "记忆 检索 日报 快照",
  "绑定 凭证 key 配置",
  "分支 提交 合并 评审",
  "排期 优先级 阻塞 依赖",
];

/** 晨报(今日计划)专用: 面向计划/待办/未完成语义的查询组 */
const PLAN_QUERY_SETS = [
  "明天 接下来 待办 计划",
  "计划 排期 下一步 要做",
  "未完成 问题 继续 需要",
  "今天 任务 优先 安排",
  "待办 工单 快照 跟踪",
];

/**
 * 单次 query 的候选池上限。
 * 注意: 这是"检索池"而非"当日条数"——服务端每个 (query,page) 只回少量条数,
 * 必须靠多查询组 × 多页把池子撑大, 再按日期过滤。原先传 20 会把池子锁死在单页量级。
 */
const QUERY_POOL_LIMIT = 200;
/** 每个查询翻页数 (服务端 page 有效, 实测 1..6 返回不同批次) */
const QUERY_PAGES = 4;

/** 晨报召回窗口: 只看 date 往前 windowDays 天内产生的记忆 (本地时区) */
const PLAN_WINDOW_DAYS = 3;

export interface MemberReport {
  member: { member_id: string; name: string };
  memories: AttributedMemory[];
  errors: string[];
  /** 层分布统计 (L1/L2/L3…), 用于核对全层检索是否真的生效 */
  levelCounts?: Record<string, number>;
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
          const res = await svc.query(uid, q, QUERY_POOL_LIMIT, QUERY_PAGES);
          for (const it of res.memories) {
            if (isWithinWindow(it, date) && it.memory_id && !found.has(it.memory_id)) found.set(it.memory_id, it);
          }
        } catch (e) {
          errors.push(`${uid} «${q}»: ${(e as Error).message}`);
        }
      }
    }
    const memories = [...found.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    members.push({
      member: { member_id: m.member_id, name: m.name },
      memories,
      errors,
      levelCounts: countLevels(memories),
    });
  }
  return { date, members };
}

/** 统计一层分布, 供核对"全层检索是否生效"(L1 原始 / L2 提炼 / L3 日聚合) */
function countLevels(items: AttributedMemory[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const raw = it as AttributedMemory & { level?: string | number; layer?: string | number };
    const lv = raw.level ?? raw.layer;
    const key = lv === undefined || lv === null || lv === "" ? "未知" : String(lv).toUpperCase();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 生成某天日报 (全员) */
export async function buildDayReport(svc: TeamMemoryService, date: string): Promise<DayReport> {
  const members: MemberReport[] = [];
  for (const m of svc.registry.members) {
    const found = new Map<string, AttributedMemory>();
    const errors: string[] = [];
    // 话题探针组 + 日期锚定查询: 语义检索按相关度排序、与日期无关,
    // 直接用日期字符串去匹配 (当日记忆内容通常带日期), 召回远比纯话题词稳
    const queries = [...QUERY_SETS, `${date} 完成 问题 部署`, `${date} 待办 工单 快照`, date];
    for (const uid of m.timem_user_ids) {
      for (const q of queries) {
        try {
          const res = await svc.query(uid, q, QUERY_POOL_LIMIT, QUERY_PAGES);
          for (const it of res.memories) {
            if (isOnDate(it, date) && it.memory_id && !found.has(it.memory_id)) found.set(it.memory_id, it);
          }
        } catch (e) {
          errors.push(`${uid} «${q}»: ${(e as Error).message}`);
        }
      }
    }
    const memories = [...found.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    members.push({
      member: { member_id: m.member_id, name: m.name },
      memories,
      errors,
      levelCounts: countLevels(memories),
    });
  }
  return { date, members };
}

/** 渲染为飞书文本 */
export function renderReport(r: DayReport): string {
  const lines: string[] = [`📋 团队记忆日报 · ${r.date}`];
  let total = 0;
  const layers: Record<string, number> = {};
  for (const m of r.members) {
    total += m.memories.length;
    for (const [k, v] of Object.entries(m.levelCounts ?? {})) layers[k] = (layers[k] ?? 0) + v;
  }
  lines.push(`共 ${total} 条新记忆, ${r.members.filter((x) => x.memories.length).length} 人有活动`);
  const layerStr = Object.entries(layers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (layerStr) lines.push(`层分布 (全层检索): ${layerStr}`);
  lines.push("");
  for (const m of r.members) {
    const lv = Object.entries(m.levelCounts ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    lines.push(`—— ${m.member.name} (${m.memories.length} 条${lv ? ` · ${lv}` : ""}) ——`);
    if (!m.member.member_id) lines.push("  (未登记)");
    if (!m.memories.length) {
      lines.push("  (当天无新记忆)");
    } else {
      m.memories.forEach((it, i) => {
        const time = (it.created_at ?? "").slice(11, 16);
        const raw = it as AttributedMemory & { level?: string | number; layer?: string | number };
        const lvTag = raw.level ?? raw.layer;
        const tag = lvTag ? `[${String(lvTag).toUpperCase()}] ` : "";
        const text = (it.content ?? "").replace(/\s+/g, " ").slice(0, 120);
        lines.push(`${i + 1}. [${time}] ${tag}${text}${(it.content ?? "").length > 120 ? "…" : ""}`);
      });
    }
    m.errors.forEach((e) => lines.push(`  ⚠ ${e.slice(0, 100)}`));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
