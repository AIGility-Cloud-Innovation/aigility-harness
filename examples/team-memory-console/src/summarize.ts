/**
 * 日报 LLM 摘要 — 把逐条记忆提炼为「每人摘要 + 跨人关联」
 *
 * 输入: buildDayReport 的结构化结果 (逐条原始记忆)。
 * 输出: 纯文本日报正文 (不含日期头, 由调用方拼)。
 * 失败语义: LLM 不可用/超时/异常一律返回 null, 调用方回退到逐条罗列 (renderReport),
 *           保证定时任务永不因 LLM 挂掉而断报。
 */

import type { DayReport } from "./report.js";

export interface SummarizeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 从环境变量解析网关配置; 缺 LITELLM_URL/LITELLM_KEY 时返回 null (调用方直接走回退) */
export function resolveSummarizeConfig(env: NodeJS.ProcessEnv = process.env): SummarizeConfig | null {
  const baseUrl = env["LITELLM_URL"] ?? "";
  const apiKey = env["LITELLM_KEY"] ?? "";
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    model: env["REPORT_SUMMARY_MODEL"] ?? env["TASK_PIPELINE_MODEL"] ?? "glm-4-flash",
    timeoutMs: 300_000,
  };
}

const SYSTEM_PROMPT = `你是研发团队的「团队记忆日报」编辑。给定某一天各成员的记忆条目（原始记录，可能含噪声，例如助手推理原文"Let me analyze..."），输出一份日报正文。

硬性要求：
1. 【每人摘要】对每位当天有记忆的成员，用 1-3 句话概括"当天做了什么、推进/关注了什么"，禁止逐条罗列原文；
2. 【跨人关联】若两人及以上的记忆指向同一项目、同一件事或互补进展，单独一节点明"谁和谁、围绕什么、关联在哪里"，并给一句综合判断；确无关联则写「当日未发现明显跨人关联」；
3. 只依据给定记忆概括，禁止编造记忆里没有的内容；噪声条目（空推理、重复登记）直接忽略；
4. 输出纯文本（不要 markdown 代码块、不要表格），用两行小节标题「👤 每人摘要」「🔗 跨人关联」，每人一行、以成员名开头。`;

/** 组装输入: 内容清洗 + 截断, 控制提示长度 (单条 ≤260 字, 总量软上限由条数天然限定) */
function buildUserContent(report: DayReport): string {
  const members = report.members
    .filter((m) => m.memories.length > 0)
    .map((m) => ({
      name: m.member.name,
      count: m.memories.length,
      items: m.memories.map((it) => ({
        time: (it.created_at ?? "").slice(11, 16),
        text: (it.content ?? "").replace(/\s+/g, " ").slice(0, 260),
      })),
    }));
  return JSON.stringify({ date: report.date, members }, null, 1);
}

/** 调网关生成摘要; 任何失败返回 null (不抛出) */
export async function summarizeDayReport(report: DayReport, cfg: SummarizeConfig): Promise<string | null> {
  return summarizeCore(SYSTEM_PROMPT, report, cfg);
}

const PLAN_SYSTEM_PROMPT = `你是研发团队的「晨间计划」编辑。今天是 {date}。给定每位成员近几天的记忆条目（原始记录，可能含噪声，例如助手推理原文），输出「今天可能要完成的内容」。

硬性要求：
1. 「📌 每人今日待办」每位成员用 1-3 条列出今天可能要做的事，必须来自其记忆中明确的计划、承诺或未完成事项，并在条目末尾用括号注明依据（记忆时间）；记忆里没有计划线索的成员写「暂无明确计划」，禁止编造；
2. 「🔗 关联与优先级」若多人待办指向同一项目、互为上下游或共用资源，点明关联并给出建议的协作/优先顺序；没有则写「今日无明显跨人依赖」；
3. 区分「明确承诺」与「你的推测」：推测项末尾标注「(推测)」；噪声条目（空推理、重复登记）忽略；
4. 输出纯文本（不要 markdown 代码块、不要表格），用两行小节标题「📌 每人今日待办」「🔗 关联与优先级」，每人一行、以成员名开头。`;

/** 晨报版: 提炼"今天可能要完成的内容"而非回顾 */
export async function summarizeDayPlan(report: DayReport, cfg: SummarizeConfig): Promise<string | null> {
  return summarizeCore(PLAN_SYSTEM_PROMPT.replace("{date}", report.date), report, cfg);
}

async function summarizeCore(systemPrompt: string, report: DayReport, cfg: SummarizeConfig): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildUserContent(report) },
        ],
        temperature: 0.3,
        max_tokens: 3000,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(body unreadable)");
      console.error(`[summarize] LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      return null;
    }
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) console.error("[summarize] LLM 返回空内容");
    return text || null;
  } catch (e) {
    console.error(`[summarize] LLM 调用异常: ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
