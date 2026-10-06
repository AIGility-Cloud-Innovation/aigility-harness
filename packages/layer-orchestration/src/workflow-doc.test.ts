import { describe, expect, it } from "vitest";
import {
  applyWorkflowModel,
  sameWorkflowModel,
  extractWorkflowModel,
  layeredLayout,
  originalEdgeSeq,
  topoWorkflowOrder,
} from "./workflow-doc.js";

/** 项目小助理风格：function 节点 + 头部决策注释 + enabled: false 旁路 */
const BRIEFING = `# 项目小助理 · 群聊整理工作流
# 控制方式: 把节点改成 enabled: false 即旁路该功能(图结构不动)。
#   (2026-09-30 决策: 现阶段 digest-only, 两个建单节点已禁用)

workflow:
  name: chat-briefing
  description: 监听群消息批处理
  entry_point: collect

  nodes:
    collect:
      type: function_node
      function_ref: collect_batch
      description: 取监听缓冲一批消息
      output_keys: ["batch"]

    create_task:
      type: function_node
      function_ref: create_planned_tasks
      enabled: false   # ← 现阶段禁用：不建飞书任务
      description: "飞书先行"
      output_keys: ["created"]

    notify:
      type: function_node
      function_ref: broadcast_digest
      description: 播报到机器人群
      output_keys: []

  flow:
    edges:
      - { from: collect, to: create_task }
      - { from: create_task, to: notify }
      - { from: notify, to: __end__ }
`;

/** 智悦平台风格：llm_node(system_prompt) + conditional_edges + 无顶层 description */
const DISPATCH = `workflow:
  name: executor-dispatch
  entry_point: classify
  nodes:
    classify:
      type: function_node
      description: 从任务行取 executor 字段
      function_ref: classify
      output_keys:
        - executor
    content:
      type: llm_node
      description: 文本执行器
      system_prompt: |
        你是 Aigility 任务执行器。产出高质量结果。
      output_keys:
        - result
  flow:
    edges:
      - from: content
        to: __end__
    conditional_edges:
      - from: classify
        condition: route_by_executor
        branches:
          - condition: content
            to: content
            description: 文本创作任务
`;

describe("workflow-doc 引擎（编排域 D4）", () => {
  it("提取：节点/边/条件边全量建模", () => {
    const r = extractWorkflowModel(DISPATCH)!;
    expect(r).toBeTruthy();
    expect(r.model.nodes.map((n) => n.id)).toEqual(["classify", "content"]);
    expect(r.model.nodes[1].functionRef).toBeNull();
    expect(r.model.edges).toEqual([{ from: "content", to: "__end__", src: 0 }]);
    expect(r.model.conditional[0].branches[0].to).toBe("content");
  });

  it("启用旁路节点 = 删除 enabled 键（保留行尾注释语义由文件风格决定）", () => {
    const { doc, model } = extractWorkflowModel(BRIEFING)!;
    model.nodes.find((n) => n.id === "create_task")!.enabled = true;
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    const seg = out.split("create_task:")[1]!.split("notify:")[0]!;
    expect(seg.includes("enabled")).toBe(false);
  });

  it("旁路普通节点 = 写入 enabled: false", () => {
    const { doc, model } = extractWorkflowModel(BRIEFING)!;
    model.nodes.find((n) => n.id === "collect")!.enabled = false;
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    expect(out.split("collect:")[1]!.split("create_task:")[0]!).toContain("enabled: false");
  });

  it("头部决策注释原样保留", () => {
    const { doc, model } = extractWorkflowModel(BRIEFING)!;
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    expect(out).toContain("2026-09-30 决策");
  });

  it("保守写回：system_prompt / conditional_edges / 元信息零污染", () => {
    const { doc, model } = extractWorkflowModel(DISPATCH)!;
    // 用户只改了 classify 的说明
    model.nodes.find((n) => n.id === "classify")!.description = "改过的说明";
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    expect(out).toContain("你是 Aigility 任务执行器");
    expect(out).toContain("conditional_edges");
    expect(out).toContain("route_by_executor");
    // 没有顶层 description 键 → 不得凭空补
    expect(out).not.toMatch(/^  description:/m);
  });

  it("未编辑短路 + 首存规范化后字节稳定", () => {
    const { model } = extractWorkflowModel(BRIEFING)!;
    // 未编辑 → UI 短路原文保存（sameWorkflowModel 判定）
    expect(sameWorkflowModel(model, model)).toBe(true);
    // 首次真实保存：yaml@2 会把紧括号流式序列规范化为带空格风格（一次性）
    const { doc, model: m } = extractWorkflowModel(BRIEFING)!;
    const once = applyWorkflowModel(doc, m, false, originalEdgeSeq(doc)).toString();
    expect(once).not.toBe(BRIEFING); // 紧括号被规范化
    // 之后任意次往返字节稳定
    const re = extractWorkflowModel(once)!;
    const twice = applyWorkflowModel(re.doc, re.model, false, originalEdgeSeq(re.doc)).toString();
    expect(twice).toBe(once);
    // 内容零丢失
    expect(once).toContain("2026-09-30 决策");
    expect(once).toContain("create_planned_tasks");
  });

  it("executor-dispatch 风格原样保存同样字节稳定", () => {
    const { doc, model } = extractWorkflowModel(DISPATCH)!;
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    expect(out).toBe(DISPATCH);
  });

  it("新增节点与连线可落盘并重解析", () => {
    const { doc, model } = extractWorkflowModel(BRIEFING)!;
    model.nodes.push({ id: "audit", type: "function_node", functionRef: "audit_batch", description: "审计", enabled: true, outputKeys: [] });
    model.edges = model.edges.map((e) => (e.to === "__end__" ? { from: e.from, to: "audit", src: e.src } : e));
    model.edges.push({ from: "audit", to: "__end__" });
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    const re = extractWorkflowModel(out)!;
    expect(re.model.nodes.some((n) => n.id === "audit")).toBe(true);
    expect(re.model.edges.some((e) => e.from === "notify" && e.to === "audit")).toBe(true);
    expect(re.model.edges).toHaveLength(4);
  });

  it("删边：未动的边复用原 item，仅目标边消失", () => {
    const { doc, model } = extractWorkflowModel(BRIEFING)!;
    model.edges = model.edges.filter((e) => !(e.from === "collect" && e.to === "create_task"));
    const out = applyWorkflowModel(doc, model, false, originalEdgeSeq(doc)).toString();
    expect(out).toContain("{ from: create_task, to: notify }");
    expect(out).not.toContain("{ from: collect, to: create_task }");
    expect(out).toContain("2026-09-30 决策");
  });

  it("拓扑与分层布局：分支节点深度正确", () => {
    const { model } = extractWorkflowModel(DISPATCH)!;
    expect(topoWorkflowOrder(model)[0]).toBe("classify");
    const pos = layeredLayout(model);
    expect(pos["classify"].x).toBeLessThan(pos["content"].x);
  });
});
