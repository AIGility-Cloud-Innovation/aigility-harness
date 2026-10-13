/**
 * L4 编排层: task-release-gate — 五要素放行检查单（planned → ready 的判定引擎）
 *
 * 放行规则（2026-10-03 与负责人确认）：
 *   · 五要素 = 项目(归属) / 执行人 / 现状 / 过程方法 / 目标；
 *   · 项目、执行人为结构性检查（登记表 projectRef、描述"执行者："标记，不靠 LLM）；
 *   · 现状/过程方法/目标由 LLM 只判"是否交代清楚"，不判内容对错（三要素验收官升级版）；
 *   · 五项全齐 → 自动放行 approve(via=auto, by=system)；
 *   · 缺结构要素 → 对应标签留 P（【待确认归属】/【待安排执行者】，复用既有约定）；
 *   · 缺 LLM 要素 → 【缺X】逐项列出，人补描述 +「确认 #N」→ approve(via=manual, by=复核人)；
 *   · LLM 判不准(unsure) → 【待复核】人工一票。
 *
 * 数据面：检查单的节点开关/执行者正则/LLM 提示词全部落在 YAML
 * （examples/feishu-task-loop/workflows/task-release.yaml），每次判定重新读取，
 * 改文件即生效；加载失败回退内置默认（与 task-pipeline.loadPipelineDoc 同款）。
 * 机制层（本文件）只认节点 function_ref 语义，不硬编码开关。
 */
import { readFileSync } from "node:fs";
import { parseWorkflowYaml, loadWorkflowFile } from "./workflow-driver.js";
import type { TaskRecord } from "@aigility-harness/core";
import type { Result } from "@aigility-harness/core";
import { ok, err } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";

// ── 数据面：内置默认（与 task-release.yaml 保持同构） ──────────────

export const BUILTIN_RELEASE_YAML = `
workflow:
  name: task-release
  description: 五要素放行检查单 — 项目/执行人(结构) + 现状/过程方法/目标(LLM)
  entry_point: project_check
  nodes:
    project_check:
      type: function_node
      function_ref: check_project
      enabled: true
      description: 结构性：登记表 projectRef（org/repo）；缺 → 【待确认归属】留 P
    executor_check:
      type: function_node
      function_ref: check_executor
      enabled: true
      description: 结构性：描述含执行者标记；缺 → 【待安排执行者】留 P
      config:
        pattern: "执行者：\\\\S+"
    notify_executor:
      type: function_node
      function_ref: notify_executor
      enabled: true
      description: 放行私信执行人；静默窗内合并成一条（防逐条轰炸）
      config:
        quiet_window_minutes: 30
    llm_elements:
      type: function_node
      function_ref: check_llm_elements
      enabled: true
      description: LLM 只判"是否交代清楚"，不判对错；required 要素 unsure → 【待复核】人工一票
      config:
        optional:
          - 过程方法
        elements:
          现状: "是否交代了当前状况与为什么做（背景/问题）"
          过程方法: "是否给出了可执行的方案/路径/步骤"
          目标: "是否明确做到什么程度算完成（验收标准）"
        system_prompt: >-
          你是任务要素审查员。对照检查单逐项判断下面的任务描述"是否交代清楚"该要素。
          只判清楚与否，不判内容对错、不代写内容。
          只输出 JSON：{"现状":"ok|missing|unsure","过程方法":"ok|missing|unsure","目标":"ok|missing|unsure",
          "缺什么":"一句话面向任务的补齐提示，全部 ok 时为空串"}
          判定标准：描述里能明确指出该要素说了什么 → ok；完全没提 → missing；
          提了但含糊到无法判断是否交代清楚 → unsure。
`;

/** 判定引擎可读的文档形状（workflow 段原样，节点 config 走防御性读取） */
export interface ReleaseDoc {
  name: string;
  description?: string;
  entry_point: string;
  nodes: Record<string, { enabled?: boolean; config?: Record<string, unknown>; [k: string]: unknown }>;
}

/** 加载本轮生效的检查单：每次判定重新读取（改文件即生效），失败回退内置默认 */
export function loadReleaseDoc(workflowFile?: string): { doc: ReleaseDoc; source: string } {
  if (workflowFile) {
    try {
      return { doc: loadWorkflowFile(workflowFile) as unknown as ReleaseDoc, source: workflowFile };
    } catch (e) {
      console.error(`[task-release-gate] 检查单加载失败, 回退内置默认: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return { doc: parseWorkflowYaml(BUILTIN_RELEASE_YAML) as unknown as ReleaseDoc, source: "builtin" };
}

// ── 判定 ────────────────────────────────────────────────────────

export type ElementVerdict = "ok" | "missing" | "unsure";

export interface ReleaseDecision {
  action: "auto-release" | "tag-missing" | "pending-review";
  /** 缺失/存疑的必填要素（中文键；选填要素不进这里） */
  missing: string[];
  /** 建议打的标签（按既有约定：首个标签前置在标题） */
  tags: string[];
  /** 面向群播报的逐项提示 */
  messages: string[];
  /** 选填要素未填的软提示（不阻塞放行） */
  soft: string[];
  elements: Record<string, ElementVerdict>;
}

/** 注入的 LLM 判定（生产：ctx.call(llmInferenceRef)；测试：假桩） */
export type ReleaseLlm = (req: { model?: string; system: string; user: string }) => Promise<
  Result<{ text?: string }>
>;

const TAG_BY_MISSING: Record<string, string> = {
  项目: "【待确认归属】",
  执行人: "【待安排执行者】",
};

function nodeEnabled(doc: ReleaseDoc, id: string, fallback = true): boolean {
  return doc.nodes?.[id]?.enabled ?? fallback;
}

function nodeConfig(doc: ReleaseDoc, id: string): Record<string, unknown> {
  return (doc.nodes?.[id]?.config as Record<string, unknown> | undefined) ?? {};
}

/** 判定选项（extraGuidance = 经验召回注入，追加到 LLM 审查提示词） */
export interface ReleaseGateOptions {
  extraGuidance?: string;
}

/** 对单条任务跑检查单；只判定不落库（放行动作由调用方执行 approve） */
export async function evaluateReleaseGate(
  record: TaskRecord,
  doc: ReleaseDoc,
  llm: ReleaseLlm,
  opts: ReleaseGateOptions = {},
): Promise<ReleaseDecision> {
  const missing: string[] = [];
  const tags: string[] = [];
  const messages: string[] = [];
  const soft: string[] = [];
  const elements: Record<string, ElementVerdict> = {};

  // ① 结构性：项目（归属）
  if (nodeEnabled(doc, "project_check")) {
    if (!record.projectRef) {
      missing.push("项目");
      tags.push(TAG_BY_MISSING["项目"]!);
      messages.push("尚未确认归属：群里回复「任务归属 编号 org/仓库」，或直接在标题加 [org/repo] 前缀。");
    }
    elements["项目"] = record.projectRef ? "ok" : "missing";
  }

  // ② 结构性：执行人
  if (nodeEnabled(doc, "executor_check")) {
    const pattern = new RegExp(String(nodeConfig(doc, "executor_check")["pattern"] ?? "执行者：\\S+"));
    const okExec = pattern.test(record.description ?? "");
    elements["执行人"] = okExec ? "ok" : "missing";
    if (!okExec) {
      missing.push("执行人");
      tags.push(TAG_BY_MISSING["执行人"]!);
      messages.push("尚未安排执行者：群里回复「安排执行者 编号 @姓名」，或描述里写「执行者：agent」交工人小组（免工单，产出 PR）。");
    }
  }

  // 结构性已缺 → 不烧 LLM，直接回标签（补齐后下一轮重跑）
  if (missing.length > 0) {
    return { action: "tag-missing", missing, tags, messages, soft: [], elements };
  }

  // ③ LLM：现状/过程方法/目标（optional 列表里的要素不阻塞放行）
  if (nodeEnabled(doc, "llm_elements")) {
    const cfg = nodeConfig(doc, "llm_elements");
    const elementSpecs = (cfg["elements"] as Record<string, string> | undefined) ?? {
      现状: "是否交代了当前状况与为什么做",
      过程方法: "是否给出了可执行的方案/步骤",
      目标: "是否明确验收标准",
    };
    const optionalSet = new Set(
      ((cfg["optional"] as string[] | undefined) ?? []).map((s) => String(s)),
    );
    const system =
      String(cfg["system_prompt"] ?? "你是任务要素审查员。只输出 JSON。") +
      (opts.extraGuidance?.trim() ? `\n【相关经验（判定时参考，不改变输出格式）】\n${opts.extraGuidance.trim()}` : "");
    const checklist = Object.entries(elementSpecs)
      .map(([k, v]) => `- ${k}：${v}`)
      .join("\n");
    const r = await llm({
      system,
      user: `检查单：\n${checklist}\n\n任务标题：${record.title}\n任务描述：\n${record.description ?? "(空)"}`,
    });
    if (!r.ok || !r.value?.text) {
      for (const key of Object.keys(elementSpecs)) {
        elements[key] = optionalSet.has(key) ? "missing" : "unsure";
      }
      return {
        action: "pending-review",
        missing: [],
        tags: ["【待复核】"],
        messages: ["要素审查暂不可用（LLM 未响应），请人工复核后回复「确认 编号」放行。"],
        soft: [],
        elements,
      };
    }
    const m = r.value.text.match(/\{[\s\S]*\}/);
    let parsed: Record<string, string> = {};
    try {
      parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
    } catch {
      parsed = {};
    }
    if (!Object.keys(parsed).length) {
      // 审查器失灵（输出不可解析）≠ 任务缺要素：归 unsure 转人工，不打【缺X】错怪任务
      for (const key of Object.keys(elementSpecs)) {
        elements[key] = optionalSet.has(key) ? "missing" : "unsure";
      }
      return {
        action: "pending-review",
        missing: [],
        tags: ["【待复核】"],
        messages: ["要素审查输出异常，请人工复核后回复「确认 编号」放行。"],
        soft: [],
        elements,
      };
    }
    for (const key of Object.keys(elementSpecs)) {
      const v = parsed[key] === "ok" || parsed[key] === "unsure" ? (parsed[key] as ElementVerdict) : "missing";
      elements[key] = v;
      if (v === "ok") continue;
      if (optionalSet.has(key)) {
        // 选填要素：缺了不拦，软提示一句
        soft.push(`${key} 未填（选填，不影响放行）`);
        continue;
      }
      missing.push(key);
      if (v === "unsure") {
        tags.push("【待复核】");
        messages.push(`「${key}」要素审查拿不准，请人工复核：回复「确认 编号」放行，或补全描述后重新检查。`);
      } else {
        tags.push(`【缺${key}】`);
        messages.push(`缺「${key}」：直接打字发给我即可，我记下来重新检查。`);
      }
    }
    if (missing.length > 0) {
      const anyUnsure = missing.some((k) => elements[k] === "unsure");
      return { action: anyUnsure ? "pending-review" : "tag-missing", missing, tags, messages, soft, elements };
    }
  }

  return { action: "auto-release", missing: [], tags: [], messages: [], soft, elements };
}

/**
 * 判定 + 落库一体：auto-release 直接 approve(via=auto)；tag/pending 只判定，
 * 放行留给人工 approve（「确认 编号」/看板按钮）。
 */
export async function runReleaseGate(
  registry: TaskRegistry,
  uid: string,
  doc: ReleaseDoc,
  llm: ReleaseLlm,
  opts: ReleaseGateOptions = {},
): Promise<Result<{ decision: ReleaseDecision; record?: TaskRecord }>> {
  const record = registry.get(uid);
  if (!record) return err(`task-release-gate: 未知任务 ${uid}`);
  const decision = await evaluateReleaseGate(record, doc, llm, opts);
  if (decision.action !== "auto-release") return ok({ decision });
  const res = registry.approve(uid, { via: "auto", by: "system", note: "五要素齐全自动放行" });
  if (!res.ok) return err(res.error);
  return ok({ decision, record: res.value });
}
