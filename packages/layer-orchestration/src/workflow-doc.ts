/**
 * workflow-doc — 工作流 YAML 文档引擎（编排域 D4 · 机制层）
 *
 * 服务于工作流可视化编排（workflow-studio）：把「图形编辑」安全地写回
 * aigility 工作流 YAML（workflow.nodes/flow.edges），纪律：
 *   · 保守写回——只写「文档已有键」或「用户实际改过」的字段；
 *     llm_node 的 system_prompt、flow.conditional_edges、未建模字段、注释一律原样保留；
 *   · 连线按 src 下标复用原 seq item（未动的边字节不变），新增边落简单 {from,to}；
 *   · enabled 旁路语义：启用态不落 enabled 键，旁路写 enabled: false（对齐既有文件风格）。
 * 纯函数、无 React 依赖；yaml@2 的 YAMLMap 无 keys()，键迭代必须走 items。
 */
import { parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

// ── 编辑模型（图形面的数据结构）─────────────────────────────────

export interface WorkflowNode {
  id: string;
  type: string;
  /** null = 文档中无此键（如 llm_node） */
  functionRef: string | null;
  description: string;
  enabled: boolean;
  outputKeys: string[];
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** 原文档 edges seq 的条目下标——写回时复用原 item（保注释/额外键） */
  src?: number;
}

export interface WorkflowBranch {
  condition: string;
  to: string;
  description?: string;
}

export interface WorkflowConditional {
  from: string;
  condition: string;
  branches: WorkflowBranch[];
}

export interface WorkflowDocModel {
  name: string;
  description: string;
  entryPoint: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 只读渲染用；写回永不触碰 */
  conditional: WorkflowConditional[];
}

export interface ExtractedWorkflow {
  model: WorkflowDocModel;
  doc: Document;
}

// ── 提取 ────────────────────────────────────────────────────────

/** 从 YAML 文本提取编辑模型；解析失败 / 缺 workflow.nodes 返回 null */
export function extractWorkflowModel(text: string): ExtractedWorkflow | null {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length) return null;
    const wf = (doc.toJS() as { workflow?: Record<string, unknown> })?.workflow;
    if (!wf || typeof wf.nodes !== "object" || !wf.nodes) return null;
    const nodes = Object.entries(wf.nodes as Record<string, Record<string, unknown>>).map(([id, n]) => ({
      id,
      type: String(n.type ?? "function_node"),
      functionRef: typeof n.function_ref === "string" ? n.function_ref : null,
      description: typeof n.description === "string" ? n.description : "",
      enabled: n.enabled !== false,
      outputKeys: Array.isArray(n.output_keys) ? (n.output_keys as string[]) : [],
    }));
    const rawEdges = ((wf.flow as { edges?: unknown[] })?.edges ?? []) as Array<Record<string, unknown>>;
    const edges: WorkflowEdge[] = rawEdges.map((e, i) => ({ from: String(e.from), to: String(e.to), src: i }));
    const conditional = ((wf.flow as { conditional_edges?: Record<string, unknown>[] })?.conditional_edges ?? []).map((c) => ({
      from: String(c.from),
      condition: String(c.condition ?? ""),
      branches: (Array.isArray(c.branches) ? c.branches : []) as WorkflowBranch[],
    }));
    return {
      model: {
        name: String(wf.name ?? "workflow"),
        description: String(wf.description ?? ""),
        entryPoint: String(wf.entry_point ?? nodes[0]?.id ?? ""),
        nodes, edges, conditional,
      },
      doc,
    };
  } catch {
    return null;
  }
}

/**
 * 编辑检测：当前模型是否与提取快照一致（供 UI「未编辑短路」——
 * 未编辑时直接原文保存，规避 yaml@2 toString 对紧括号流式序列的一次性规范化）。
 */
export function sameWorkflowModel(a: WorkflowDocModel, b: WorkflowDocModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 取原文档 flow.edges 的 YAMLSeq（写回时复用 item 用） */
export function originalEdgeSeq(doc: Document): YAMLSeq | null {
  const wf = doc.get("workflow", true) as YAMLMap | undefined;
  const flow = wf?.get("flow", true) as YAMLMap | undefined;
  return (flow?.get("edges", true) as YAMLSeq | undefined) ?? null;
}

// ── 写回 ────────────────────────────────────────────────────────

/** 保守写回：只动建模字段；system_prompt/conditional_edges/未知键/注释原样保留 */
export function applyWorkflowModel(
  origDoc: Document,
  model: WorkflowDocModel,
  docMissing: boolean,
  origEdges: YAMLSeq | null,
): Document {
  const d = docMissing ? (parseDocument("") as Document) : origDoc;
  let wf = d.get("workflow", true) as YAMLMap | undefined;
  if (!wf) { d.set("workflow", d.createNode({})); wf = d.get("workflow", true) as YAMLMap }

  // 元信息：文档已有该键才写，且值变化才写（字节稳定的的关键——未编辑就不产生格式漂移）
  const setIfChanged = (map: YAMLMap, key: string, val: unknown) => {
    if (map.has(key) && map.get(key) !== val) map.set(key, val);
  };
  if (docMissing) {
    wf.set("name", model.name);
    wf.set("description", model.description);
    wf.set("entry_point", model.entryPoint);
  } else {
    setIfChanged(wf, "name", model.name);
    setIfChanged(wf, "description", model.description);
    setIfChanged(wf, "entry_point", model.entryPoint);
  }

  // nodes：增量改；删除不在模型里的
  let nodes = wf.get("nodes", true) as YAMLMap | undefined;
  if (!nodes) { nodes = d.createNode({}) as YAMLMap; wf.set("nodes", nodes) }
  for (const item of [...nodes.items]) {
    const id = String((item.key as { value: string | number }).value);
    if (!model.nodes.some((n) => n.id === id)) nodes.delete(id);
  }
  for (const n of model.nodes) {
    let y = nodes.get(n.id, true) as YAMLMap | undefined;
    const isNew = !y;
    if (!y) { y = d.createNode({}) as YAMLMap; nodes.set(n.id, y) }
    if (isNew) {
      y.set("type", n.type);
      if (n.functionRef) y.set("function_ref", n.functionRef);
      if (n.description) y.set("description", n.description);
      if (!n.enabled) y.set("enabled", false);
      if (n.outputKeys.length) y.set("output_keys", d.createNode(n.outputKeys));
      continue;
    }
    // 已存在节点：文档已有该键、且值确实变化才写（避免 inline→block 等格式漂移）；enabled 例外（旁路语义）
    if (y.has("function_ref") && n.functionRef !== null && y.get("function_ref") !== n.functionRef) {
      y.set("function_ref", n.functionRef);
    }
    if (y.has("description") && y.get("description") !== n.description) y.set("description", n.description);
    if (n.enabled) { if (y.has("enabled")) y.delete("enabled"); } else { if (y.get("enabled") !== false) y.set("enabled", false); }
    if (y.has("output_keys")) {
      const cur = y.get("output_keys");
      const curArr = Array.isArray(cur) ? cur : (cur as YAMLSeq).toJS(d);
      if (JSON.stringify(curArr) !== JSON.stringify(n.outputKeys)) y.set("output_keys", d.createNode(n.outputKeys));
    }
  }

  // edges：src 复用原 seq item（未动的边字节不变），新增边落简单 {from,to}；
  // flow.conditional_edges 与 flow 的其他键一律不触碰。
  if (model.edges.length || origEdges) {
    let flow = wf.get("flow", true) as YAMLMap | undefined;
    if (!flow) { flow = d.createNode({}) as YAMLMap; wf.set("flow", flow) }
    const seq = flow.get("edges", true) as YAMLSeq | undefined;
    if (!seq) {
      flow.set("edges", d.createNode(model.edges.map((e) => ({ from: e.from, to: e.to }))));
    } else {
      const origItems = origEdges?.items ?? seq.items;
      seq.items = model.edges.map((e) => {
        if (e.src != null && origItems[e.src]) {
          const it = origItems[e.src];
          const j = (it as YAMLMap).toJS(d) ?? {};
          // 端点一致才复用（保注释/额外键）；端点被编辑过必须落新内容
          if (String(j.from) === e.from && String(j.to) === e.to) return it;
        }
        return d.createNode({ from: e.from, to: e.to });
      });
    }
  }
  return d;
}

// ── 布局辅助 ────────────────────────────────────────────────────

/** 拓扑排序（简单边 + 条件边都计入层级；环/断链兜底按模型顺序） */
export function topoWorkflowOrder(model: WorkflowDocModel): string[] {
  const ids = model.nodes.map((n) => n.id);
  const inDeg = new Map(ids.map((id) => [id, 0]));
  for (const e of model.edges) if (inDeg.has(e.to)) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  for (const c of model.conditional) {
    if (inDeg.has(c.from)) inDeg.set(c.from, Math.max(inDeg.get(c.from) ?? 0, 1));
    for (const b of c.branches) if (inDeg.has(b.to) && b.to !== c.from) inDeg.set(b.to, (inDeg.get(b.to) ?? 0) + 1);
  }
  const out: string[] = [];
  const queue = ids.filter((id) => (inDeg.get(id) ?? 0) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of model.edges) if (e.from === id && inDeg.has(e.to)) {
      const d = (inDeg.get(e.to) ?? 1) - 1;
      inDeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
    for (const c of model.conditional) if (c.from === id) {
      for (const b of c.branches) if (inDeg.has(b.to) && b.to !== c.from) {
        const d = (inDeg.get(b.to) ?? 1) - 1;
        inDeg.set(b.to, d);
        if (d === 0) queue.push(b.to);
      }
    }
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * 分层自动布局（左→右）：列 = 从入口起的最长路径深度，行 = 同列内序。
 * 坐标是纯视图状态（不写回 YAML）。
 */
export function layeredLayout(
  model: WorkflowDocModel,
  opts: { colWidth?: number; rowHeight?: number; originX?: number; originY?: number } = {},
): Record<string, { x: number; y: number }> {
  const { colWidth = 250, rowHeight = 120, originX = 48, originY = 44 } = opts;
  const order = topoWorkflowOrder(model);
  const depth = new Map<string, number>();
  for (const id of order) depth.set(id, 0);
  for (const id of order) {
    const relax = (to: string) => {
      if (depth.has(to) && to !== id) depth.set(to, Math.max(depth.get(to)!, depth.get(id)! + 1));
    };
    for (const e of model.edges) if (e.from === id) relax(e.to);
    for (const c of model.conditional) if (c.from === id) for (const b of c.branches) relax(b.to);
  }
  const byCol = new Map<number, string[]>();
  for (const id of order) {
    const col = depth.get(id) ?? 0;
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col)!.push(id);
  }
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [col, ids] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => { pos[id] = { x: originX + col * colWidth, y: originY + row * rowHeight }; });
  }
  return pos;
}
