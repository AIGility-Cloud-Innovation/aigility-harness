/**
 * 任务拆解器（Plan 阶段）—— 复用 layer-orchestration 的 consolidation 纯函数
 *
 * 输入任务标题+说明 → LLM 拆解为子任务 DAG（items/dependsOn/acceptanceCriteria + designDoc）
 * → 生成 aigility workflow YAML（每个子任务一个 llm_node，拓扑序连边至 __end__）
 * → 落盘 data/workflows/<taskId>.yaml，交任务板人审；批准后经 py-bridge
 *   （@orchestration/workflow-runtime → aigility.workflow.runtime.run_yaml_workflow）执行。
 *
 * YAML 契约对齐 aigility/workflow/schema.py（WorkflowConfig：workflow.name/entry_point/
 * nodes/flow.edges），条件边与 capability_node 留给后续增强。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dump as yamlDump } from "js-yaml";
import {
  CONSOLIDATION_SYSTEM_PROMPT,
  parseConsolidation,
  buildConsolidation,
} from "@aigility-harness/layer-orchestration";
import type { ConsolidationItem } from "@aigility-harness/layer-orchestration";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_DIR = resolve(__dirname, "../data/workflows");

export interface PlanResult {
  yamlText: string;
  yamlPath: string;
  items: ConsolidationItem[];
  designDoc: string;
}

/** 拆解器 system prompt：沿用 consolidation 的 JSON 契约，语义改为"任务 → 子任务 DAG" */
const PLANNER_SYSTEM_PROMPT = [
  "你是任务拆解器。把用户给出的任务拆解为可由 agent 依次执行的子任务有向无环图(DAG)。",
  '只输出一个 JSON 对象，格式：{"items":[{"requirement_ids":["req-1"],"task_title":"子任务标题","task_description":"具体做什么(给执行 agent 的完整指令)","depends_on":[前置 items 下标数组],"acceptance_criteria":["验收标准"]}],"design_doc":"统一设计方案(markdown)"}',
  "要求：",
  "- 每个子任务独立可执行、可验收；执行者是大语言模型 agent（产出文本/文档/代码建议），不要安排只有人才能做的动作。",
  "- depends_on 用 items 数组下标且不得自引用；无依赖为空数组；按依赖顺序排列 items。",
  "- 所有子任务的 requirement_ids 必须是 [\"req-1\"]。",
  "- 任务简单时给单个子任务即可，不要硬拆。",
].join("\n");

type CallLlm = (messages: Array<{ role: string; content: string }>) => Promise<string>;

/**
 * 拆解任务并生成工作流 YAML。callLlm 由调用方注入（Web 层经 Seam 调 @cognitive/llm-inference）。
 * 抛错 = 拆解失败（LLM 不可用/输出不合法），由调用方决定任务状态。
 */
export async function planTask(
  taskId: string,
  title: string,
  detail: string,
  callLlm: CallLlm,
): Promise<PlanResult> {
  const userContent = `req-1: ${title}\n${detail || "(无补充说明)"}`;
  let parsed: { items: ConsolidationItem[]; designDoc: string } | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const raw = await callLlm([
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ]);
    parsed = parseConsolidation(raw, [
      { id: "req-1", sessionId: taskId, content: `${title}\n${detail || ""}`, rawMessage: title, createdAt: Date.now(), status: "open" as const },
    ]);
    lastError = "拆解输出不合法（JSON 契约不满足/需求未全覆盖）";
  }
  if (!parsed) throw new Error(lastError);

  const cons = buildConsolidation(taskId, parsed.items, parsed.designDoc, 1);
  const order = cons.executionOrder;

  // 生成 YAML：拓扑序线性链 n0→n1→…→__end__（dependsOn 已由 LLM 给出，
  // v1 取拓扑主链保证可执行；并行分支与条件边留后续增强）
  const nodes: Record<string, unknown> = {};
  for (const [i, idx] of order.entries()) {
    const item = cons.items[idx];
    nodes[`n${idx}`] = {
      type: "llm_node",
      description: item.taskTitle,
      system_prompt: [
        `【统一设计】\n${cons.designDoc || "(无)"}`,
        `【子任务】${item.taskTitle}\n${item.taskDescription}`,
        item.acceptanceCriteria.length ? `【验收标准】\n${item.acceptanceCriteria.map((a) => `- ${a}`).join("\n")}` : "",
        "基于以上完成任务，直接输出结果（Markdown），不要输出与任务无关的内容。",
      ].filter(Boolean).join("\n\n"),
      output_keys: ["result"],
    };
  }
  const edges = order.map((idx, i) =>
    i < order.length - 1
      ? { from: `n${idx}`, to: `n${order[i + 1]}` }
      : { from: `n${idx}`, to: "__end__" },
  );

  const doc = {
    workflow: {
      name: `task-${taskId}`,
      description: `任务「${title}」的自动拆解编排（Plan 阶段产出，人审后执行）`,
      entry_point: `n${order[0]}`,
      nodes,
      flow: { edges },
    },
  };
  const yamlText = yamlDump(doc, { lineWidth: -1 });

  const yamlPath = resolve(WORKFLOW_DIR, `${taskId}.yaml`);
  mkdirSync(dirname(yamlPath), { recursive: true });
  writeFileSync(yamlPath, yamlText, "utf-8");

  return { yamlText, yamlPath, items: cons.items, designDoc: cons.designDoc };
}
