/**
 * L4 编排层: agent-decision — 工人决策点契约（暂停等人机制，2026-10-13）
 *
 * 背景：工人（codex 等）执行中遇方案分叉/歧义，过去只能硬选或落 failed 终态，
 * 没有暂停等人工决策的通道。本模块定义「决策文件」这一唯一握手点：
 *
 *   工人侧（worker prompt 约定，见 DECISION_RULES）：
 *     遇分歧 → 在工作区根写 `.agent-decision.json`（JSON，UTF-8，覆盖式写）
 *     → 结束本轮（状态码 0 正常结束即可，worker-team 凭文件判定暂停）。
 *
 *   宿主侧（worker-team 回流）：
 *     跑完看到 .agent-decision.json → 记 needs-input 暂停，不落 failed；
 *     机器人群结构化播报请求决策（任务号 + 问题 + 选项 + 推荐）。
 *
 *   决策侧（群回复「决策 <任务号> <选项>」→ 编排层决策处理）：
 *     把用户选择写回决策文件（结论+决策人），needs-input → running 重入队；
 *     worker-team 领到 running 任务 → 用「原线程 + 决策结论」同上下文续跑
 *     （codex-agent 已支持 threadId resume，prompt 注入决策结论，不重跑）。
 *
 * 超时兜底（可配）：needs-input 超过 DECISION_TIMEOUT_MS 未决策 → 自动按默认项
 * （或转 failed），由 worker-team 扫描回合处理。
 *
 * 文件命名 .agent-decision.json 放工作区根：与任务 uid 解耦（工作区一次一任务，
 * 由收尾器快照防混流），供 worker 用任意语言/CLI 直写，宿主只读不猜。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 决策文件文件名（工作区根固定名，worker prompt 约定） */
export const DECISION_FILE = ".agent-decision.json";

/** 决策文件内容（工人写 → 宿主读 → 决策人改写结论 → 工人 resume 读） */
export interface AgentDecision {
  /** 决策点标题（短，进群播报） */
  question: string;
  /** 展开描述（给决策人看的上下文，可多行） */
  context?: string;
  /** 选项列表（至少 1 个；首项 = 推荐项） */
  options: string[];
  /** 缺省项下标（0-based；不写 = 0 = 推荐项；超时兜底用） */
  defaultOption?: number;
  /** 决策结论（decision 意图写回）；未决策时空缺 */
  decision?: string;
  /** 决策人（用户别名/飞书名）；未决策时空缺 */
  decidedBy?: string;
  /** 决策时间 ISO；未决策时空缺 */
  decidedAt?: string;
  /** 决策来源消息（原始文本摘录） */
  decidedFrom?: string;
}

/** worker prompt 决策约定（注入派发提示词，见 worker-team dispatch） */
export const DECISION_RULES = `【决策暂停约定（重要）】
1. 执行中遇方案分叉/歧义/拿不准的取舍，不要硬选、不要跳过、不要落失败。
2. 在工作区根写决策文件 .agent-decision.json，结构：
   {"question":"一句话问题","context":"展开背景（可选）","options":["方案A","方案B",...]}
   options 首项必须是你的推荐项；写完后正常结束本轮（本文件会被宿主识别并暂停等你回复）。
3. 不要自己修改 .agent-decision.json 的 decision 字段——决策人回复后会由宿主写回，
   并在重入队续跑时把结论注入你的上下文。

【续跑约定（重要）】
被暂停后，宿主会以「同一会话/线程 + 决策结论」重新唤起你（不会重跑）。
看到 injected_decision 段时：按决策结论继续执行，把结论当作已拍板的最终选择，
不要再质疑选项、不要再开新的决策点（除非出现新的实质性分叉）。`;

/** 解析决策文件内容；文件不存在/非法返回 undefined（宿主只认合法文件） */
export function parseAgentDecision(raw: string): AgentDecision | undefined {
  try {
    const j = JSON.parse(raw) as Partial<AgentDecision>;
    if (typeof j.question !== "string" || !j.question.trim()) return undefined;
    if (!Array.isArray(j.options) || j.options.length === 0 ||
        j.options.some((o) => typeof o !== "string" || !o.trim())) return undefined;
    return {
      question: j.question.trim(),
      ...(typeof j.context === "string" && j.context.trim() ? { context: j.context.trim() } : {}),
      options: j.options.map((o) => String(o).trim()),
      ...(typeof j.defaultOption === "number" ? { defaultOption: j.defaultOption } : {}),
      ...(typeof j.decision === "string" && j.decision.trim() ? { decision: j.decision.trim() } : {}),
      ...(typeof j.decidedBy === "string" && j.decidedBy.trim() ? { decidedBy: j.decidedBy.trim() } : {}),
      ...(typeof j.decidedAt === "string" && j.decidedAt.trim() ? { decidedAt: j.decidedAt.trim() } : {}),
      ...(typeof j.decidedFrom === "string" && j.decidedFrom.trim() ? { decidedFrom: j.decidedFrom.trim() } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 校验 options 下标；越界/缺失回落 0（推荐项） */
export function optionIndex(d: AgentDecision, i: number | undefined): number {
  const n = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < d.options.length ? i : 0;
  return n;
}

/** 读取工作区根决策文件（不存在返回 undefined）；parse 失败返回 {invalid:true} */
export function readAgentDecision(cwd: string):
  | { found: false }
  | { found: true; invalid?: boolean; decision?: AgentDecision } {
  const file = join(cwd, DECISION_FILE);
  if (!existsSync(file)) return { found: false };
  const raw = readFileSync(file, "utf-8");
  const d = parseAgentDecision(raw);
  return d ? { found: true, decision: d } : { found: true, invalid: true };
}

/** 写回决策结论（决策人选择）；仅允许对「未决策的合法文件」写结论（重复提交/已完成返回 err） */
export function writeDecision(
  cwd: string,
  decision: string,
  opts: { decidedBy?: string; decidedFrom?: string } = {},
): { ok: boolean; error?: string } {
  if (!decision || !decision.trim()) return { ok: false, error: "决策选项为空" };
  const file = join(cwd, DECISION_FILE);
  if (!existsSync(file)) return { ok: false, error: "决策文件不存在（任务可能已完成/已取消）" };
  let cur: ReturnType<typeof readAgentDecision>;
  try {
    cur = readAgentDecision(cwd);
  } catch (e) {
    return { ok: false, error: `决策文件读取失败: ${String((e as Error)?.message ?? e)}` };
  }
  if (!cur.found) return { ok: false, error: "决策文件不存在（任务可能已完成/已取消）" };
  if (cur.invalid || !cur.decision) return { ok: false, error: "决策文件格式非法，无法写回" };
  if (cur.decision.decision) return { ok: false, error: "该决策点已完成（已有决策结论），请勿重复提交" };
  const next: AgentDecision = {
    ...cur.decision,
    decision: decision.trim(),
    ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}),
    ...(opts.decidedFrom ? { decidedFrom: opts.decidedFrom } : {}),
    decidedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 清理决策文件（终态落定后调用；失败不阻塞主流程） */
export function removeDecisionFile(cwd: string): void {
  try {
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(join(cwd, DECISION_FILE));
  } catch {
    // 不存在/权限问题都无所谓（决策已完成）
  }
}

/** 决策文件存在、合法且尚未写结论 → 需暂停等人工 */
export function isPendingDecision(
  d: ReturnType<typeof readAgentDecision>,
): d is { found: true; decision: AgentDecision & { decision?: undefined } } {
  return (
    d.found === true &&
    d.invalid !== true &&
    !!d.decision &&
    (typeof d.decision.decision !== "string" || d.decision.decision.length === 0)
  );
}

/** 决策文件存在且已带结论（供 worker-team 续跑时展示/注入） */
export function hasConclusion(d: ReturnType<typeof readAgentDecision>): d is { found: true; decision: AgentDecision & { decision: string } } {
  return d.found === true && d.invalid !== true && !!d.decision && typeof d.decision.decision === "string" && d.decision.decision.length > 0;
}

