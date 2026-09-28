/**
 * L4 编排规划层: 通用 YAML 工作流驱动器 (数据面)
 *
 * 与 Python 侧 aigility/workflow 对齐: 同一份 WorkflowConfig 契约
 * (workflow.name / entry_point / nodes / flow.edges / flow.conditional_edges,
 * `__end__` 终点), 两侧各自都能执行——
 *   - Python 侧 (aigility.workflow.WorkflowBuilder): 完整 LangGraph 运行时,
 *     支持 llm_node / state_schema / 子图, 经 py-bridge 以 Seam 暴露
 *   - TS 侧 (本文件): 轻量数据面驱动——节点函数与条件函数由调用方注册
 *     (闭包注入, 与 Python 侧 node_registry / condition_registry 同构),
 *     引擎只负责「读 YAML → 校验 → 沿边走」的过程控制
 *
 * 定位 (对应 AI 治理路线图的编排分类): 只承接「节点 + 条件边」的数据面编排
 * (如任务板执行器路由、PDCA 子任务 DAG); 过程驱动的执行面逻辑
 * (UDS 通信 / 轮询 / CAS 等状态机内部细节) 留在节点函数体内, 不进 YAML。
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

// ── 配置契约 (对齐 aigility/workflow/schema.py 的 WorkflowConfig) ──

export interface WorkflowNodeConfig {
  type?: string;
  description?: string;
  /** llm_node: 内联提示词 (Python 侧 _make_llm_node 同名兼容) */
  system_prompt?: string;
  /** llm_node: 提示词引用, 格式 module.prompt_name 或直接文本 */
  prompt_ref?: string;
  /** function_node: 函数引用名 (TS 侧作为节点函数注册表的查找键) */
  function_ref?: string;
  /** capability_node: Seam 能力 ID (文档性声明; TS 驱动器不直接解析) */
  capability_ref?: string;
  output_keys?: string[];
  [key: string]: unknown;
}

export interface WorkflowEdgeConfig {
  from: string;
  to: string;
}

export interface WorkflowBranchConfig {
  condition: string;
  to: string;
  description?: string;
}

export interface WorkflowConditionalEdgeConfig {
  from: string;
  /** 条件函数名 (查找键, 对齐 condition_registry) */
  condition: string;
  description?: string;
  branches: WorkflowBranchConfig[];
}

export interface WorkflowFlowConfig {
  edges?: WorkflowEdgeConfig[];
  conditional_edges?: WorkflowConditionalEdgeConfig[];
}

export interface WorkflowDoc {
  name: string;
  description?: string;
  entry_point: string;
  nodes: Record<string, WorkflowNodeConfig>;
  flow?: WorkflowFlowConfig;
}

/** 节点函数: 收到当前 state 与节点配置, 返回要合并回 state 的增量 (可异步) */
export type WorkflowNodeFn<S> = (
  state: S,
  node: WorkflowNodeConfig,
) => Promise<Partial<S> | void> | Partial<S> | void;

/** 条件函数: 返回分支键 (对应 conditional_edges.branches[].condition) */
export type WorkflowConditionFn<S> = (state: S) => Promise<string> | string;

export interface WorkflowValidation {
  errors: string[];
  warnings: string[];
}

export interface WorkflowRunResult<S> {
  /** false = 中途出错 (errors 非空), state 停留在最后一致点 */
  ok: boolean;
  /** 实际走过的节点 ID (不含 __end__) */
  path: string[];
  /** 走完后 (或出错时) 的最终 state */
  state: S;
  errors: string[];
}

// ── 解析 ────────────────────────────────────────────────────────

/** 解析 YAML 文本为 WorkflowDoc; 结构非法时抛错 (错误信息含原因) */
export function parseWorkflowYaml(text: string): WorkflowDoc {
  const raw = yaml.load(text) as { workflow?: Partial<WorkflowDoc> } | null;
  const wf = raw?.workflow;
  if (!wf || typeof wf !== "object") {
    throw new Error("工作流 YAML 结构非法: 缺少顶层 workflow 段");
  }
  if (!wf.name || !wf.entry_point) {
    throw new Error("工作流 YAML 结构非法: 缺少 workflow.name / workflow.entry_point");
  }
  if (!wf.nodes || typeof wf.nodes !== "object") {
    throw new Error("工作流 YAML 结构非法: 缺少 workflow.nodes");
  }
  return wf as WorkflowDoc;
}

/** 从文件路径加载 WorkflowDoc (文件不存在 / 解析失败抛错) */
export function loadWorkflowFile(path: string): WorkflowDoc {
  return parseWorkflowYaml(readFileSync(path, "utf-8"));
}

// ── 驱动器 ──────────────────────────────────────────────────────

const END = "__end__";
/** 环路保护: 单次 run 的最大节点步数 (默认 64, 够深 DAG 用, 又能兜住坏图) */
const DEFAULT_MAX_STEPS = 64;

export class YamlWorkflow<S = Record<string, unknown>> {
  readonly doc: WorkflowDoc;
  private readonly nodeFns = new Map<string, WorkflowNodeFn<S>>();
  private readonly conditionFns = new Map<string, WorkflowConditionFn<S>>();
  private readonly normalOut = new Map<string, string>();
  private readonly condOut = new Map<string, WorkflowConditionalEdgeConfig>();

  constructor(doc: WorkflowDoc) {
    this.doc = doc;
    for (const e of doc.flow?.edges ?? []) {
      if (!this.normalOut.has(e.from)) this.normalOut.set(e.from, e.to);
    }
    for (const c of doc.flow?.conditional_edges ?? []) {
      if (!this.condOut.has(c.from)) this.condOut.set(c.from, c);
    }
  }

  /** 节点函数注册: 键 = 节点 ID, 或节点 function_ref 指向的名字 (后者优先查找) */
  registerNode(key: string, fn: WorkflowNodeFn<S>): this {
    this.nodeFns.set(key, fn);
    return this;
  }

  registerNodes(entries: Record<string, WorkflowNodeFn<S>>): this {
    for (const [k, fn] of Object.entries(entries)) this.registerNode(k, fn);
    return this;
  }

  /** 条件函数注册: 键 = conditional_edges.condition 名 */
  registerCondition(key: string, fn: WorkflowConditionFn<S>): this {
    this.conditionFns.set(key, fn);
    return this;
  }

  /** 人审/启动前校验: errors 阻断运行, warnings 仅提示 (如节点未注册实现) */
  validate(): WorkflowValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const ids = new Set(Object.keys(this.doc.nodes));

    if (!ids.has(this.doc.entry_point)) {
      errors.push(`entry_point「${this.doc.entry_point}」不在 nodes 中`);
    }
    for (const [id, cfg] of Object.entries(this.doc.nodes)) {
      const fnKey = (cfg.function_ref as string | undefined) ?? id;
      if (!this.nodeFns.has(fnKey) && !this.nodeFns.has(id)) {
        warnings.push(`节点「${id}」未注册实现 (function_ref=${String(cfg.function_ref ?? id)})`);
      }
    }
    for (const e of this.doc.flow?.edges ?? []) {
      if (!ids.has(e.from)) errors.push(`边起点「${e.from}」不是已声明节点`);
      if (e.to !== END && !ids.has(e.to)) errors.push(`边终点「${e.to}」不是已声明节点`);
    }
    for (const c of this.doc.flow?.conditional_edges ?? []) {
      if (!ids.has(c.from)) errors.push(`条件边起点「${c.from}」不是已声明节点`);
      if (!this.conditionFns.has(c.condition)) {
        errors.push(`条件函数「${c.condition}」未注册`);
      }
      if (!c.branches?.length) {
        errors.push(`条件边「${c.from}」没有任何分支`);
      }
      for (const b of c.branches ?? []) {
        if (b.to !== END && !ids.has(b.to)) errors.push(`分支「${b.condition}」终点「${b.to}」不是已声明节点`);
      }
    }
    return { errors, warnings };
  }

  private resolveNodeFn(id: string, cfg: WorkflowNodeConfig): WorkflowNodeFn<S> | undefined {
    const fnKey = (cfg.function_ref as string | undefined) ?? id;
    return this.nodeFns.get(fnKey) ?? this.nodeFns.get(id);
  }

  /**
   * 从 entry_point 沿边执行到 __end__ (或无出边的汇点)。
   * 不抛异常: 节点函数抛错 / 分支未命中 / 环路超步, 都以 ok:false + errors 返回,
   * state 保留到最后一致点, 由调用方决定善后 (与 Seam 的值错误风格一致)。
   */
  async run(initial: S, opts?: { maxSteps?: number }): Promise<WorkflowRunResult<S>> {
    const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
    const state = { ...initial } as S;
    const patch = (p: Partial<S> | void) => {
      if (p && typeof p === "object") Object.assign(state as object, p);
    };
    const path: string[] = [];
    const errors: string[] = [];

    let current = this.doc.entry_point;
    for (let step = 0; step < maxSteps; step++) {
      const cfg = this.doc.nodes[current];
      if (!cfg) {
        errors.push(`节点「${current}」未在 YAML 中声明`);
        return { ok: false, path, state, errors };
      }
      const fn = this.resolveNodeFn(current, cfg);
      if (!fn) {
        errors.push(`节点「${current}」没有可执行实现 (未注册)`);
        return { ok: false, path, state, errors };
      }
      path.push(current);
      try {
        patch(await fn(state, cfg));
      } catch (e) {
        errors.push(`节点「${current}」执行失败: ${String((e as Error)?.message ?? e)}`);
        return { ok: false, path, state, errors };
      }

      const next = this.normalOut.get(current);
      if (next) {
        if (next === END) return { ok: true, path, state, errors };
        current = next;
        continue;
      }
      const cond = this.condOut.get(current);
      if (cond) {
        const condFn = this.conditionFns.get(cond.condition);
        if (!condFn) {
          errors.push(`条件函数「${cond.condition}」未注册`);
          return { ok: false, path, state, errors };
        }
        let key: string;
        try {
          key = String(await condFn(state));
        } catch (e) {
          errors.push(`条件函数「${cond.condition}」执行失败: ${String((e as Error)?.message ?? e)}`);
          return { ok: false, path, state, errors };
        }
        const branch = cond.branches.find((b) => b.condition === key);
        if (!branch) {
          errors.push(`条件边「${current}」分支未命中: 条件函数返回「${key}」, 可选分支 [${cond.branches.map((b) => b.condition).join(", ")}]`);
          return { ok: false, path, state, errors };
        }
        if (branch.to === END) return { ok: true, path, state, errors };
        current = branch.to;
        continue;
      }
      // 无出边: 汇点, 视为正常结束 (对齐 LangGraph 中孤立终点节点的直觉)
      return { ok: true, path, state, errors };
    }
    errors.push(`超过最大步数 ${maxSteps}, 疑似环路 (path=${path.join("→")})`);
    return { ok: false, path, state, errors };
  }
}
