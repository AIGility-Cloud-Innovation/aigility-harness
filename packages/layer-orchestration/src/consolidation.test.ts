/** consolidation 单测: JSON 强校验 / 拓扑排序含环 / 渲染 */
import { describe, expect, it } from "vitest";
import {
  buildConsolidation,
  parseConsolidation,
  renderConsolidation,
  topoSort,
} from "./consolidation.js";
import type { Requirement } from "./requirement-store.js";

function req(id: string, content: string): Requirement {
  return { id, sessionId: "s", content, rawMessage: content, createdAt: 0, status: "open" };
}

const REQS = [req("req_a", "深色模式"), req("req_b", "导出 Excel"), req("req_c", "Excel 带头像"), req("req_d", "优化登录")];

const VALID_LLM_OUTPUT = `{"items":[
  {"requirement_ids":["req_b","req_c"],"task_title":"导出 Excel 含头像","task_description":"用户列表导出 Excel 并带头像链接","merged_reason":"req_b 与 req_c 都关于导出","depends_on":[],"acceptance_criteria":["导出文件含头像列"]},
  {"requirement_ids":["req_a"],"task_title":"全站深色模式","task_description":"实现深色模式","depends_on":[],"acceptance_criteria":["可切换"]},
  {"requirement_ids":["req_d"],"task_title":"登录性能优化","task_description":"优化登录速度","depends_on":[0,1],"blocked_by_conflict":"与深色模式争抢登录页样式","missing_information":["当前登录耗时基线"],"acceptance_criteria":["登录 <1s"]}
],"design_doc":"# 统一设计\\n先做无依赖项"}`;

describe("parseConsolidation", () => {
  it("合法输出(含 ```json 围栏)解析成功, 类型映射正确", () => {
    const wrapped = "前置杂文\n```json\n" + VALID_LLM_OUTPUT + "\n```\n后置";
    const r = parseConsolidation(wrapped, REQS);
    expect(r).not.toBeNull();
    expect(r!.items).toHaveLength(3);
    expect(r!.items[0]!.requirementIds).toEqual(["req_b", "req_c"]);
    expect(r!.items[0]!.mergedReason).toContain("导出");
    expect(r!.items[2]!.dependsOn).toEqual([0, 1]);
    expect(r!.items[2]!.missingInformation).toEqual(["当前登录耗时基线"]);
    expect(r!.designDoc).toContain("统一设计");
  });

  it("静默丢弃需求 → 拒绝(全覆盖校验)", () => {
    const raw = JSON.stringify({
      items: [{ requirement_ids: ["req_a"], task_title: "t", task_description: "d", depends_on: [], acceptance_criteria: [] }],
      design_doc: "",
    });
    expect(parseConsolidation(raw, REQS)).toBeNull();
  });

  it("引用未知 req id → 拒绝", () => {
    const raw = JSON.stringify({
      items: REQS.map((r) => ({ requirement_ids: [r.id], task_title: "t", task_description: "d", depends_on: [], acceptance_criteria: [] })).concat([
        { requirement_ids: ["req_ghost"], task_title: "t", task_description: "d", depends_on: [], acceptance_criteria: [] },
      ]),
      design_doc: "",
    });
    expect(parseConsolidation(raw, REQS)).toBeNull();
  });

  it("自依赖被过滤, 越界下标被过滤", () => {
    const raw = JSON.stringify({
      items: [
        { requirement_ids: ["req_a"], task_title: "t1", task_description: "d", depends_on: [0, 99], acceptance_criteria: [] },
        { requirement_ids: ["req_b", "req_c", "req_d"], task_title: "t2", task_description: "d", depends_on: [], acceptance_criteria: [] },
      ],
      design_doc: "",
    });
    const r = parseConsolidation(raw, REQS)!;
    expect(r.items[0]!.dependsOn).toEqual([]);
  });

  it("非 JSON / 缺 title / 空 items → 均 null", () => {
    expect(parseConsolidation("这不是JSON", REQS)).toBeNull();
    expect(parseConsolidation('{"items":[]}', REQS)).toBeNull();
    expect(
      parseConsolidation(
        JSON.stringify({ items: [{ requirement_ids: ["req_a"], task_description: "d", depends_on: [], acceptance_criteria: [] }] }),
        REQS,
      ),
    ).toBeNull();
  });
});

describe("topoSort", () => {
  it("无环 DAG 拓扑序: 依赖者在前", () => {
    const order = topoSort([
      { requirementIds: ["a"], taskTitle: "A", taskDescription: "", dependsOn: [1, 2], acceptanceCriteria: [] },
      { requirementIds: ["b"], taskTitle: "B", taskDescription: "", dependsOn: [], acceptanceCriteria: [] },
      { requirementIds: ["c"], taskTitle: "C", taskDescription: "", dependsOn: [1], acceptanceCriteria: [] },
    ])!;
    expect(order).not.toBeNull();
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(0));
  });

  it("有环 → null (调用方回退 LLM 原序)", () => {
    const order = topoSort([
      { requirementIds: ["a"], taskTitle: "A", taskDescription: "", dependsOn: [1], acceptanceCriteria: [] },
      { requirementIds: ["b"], taskTitle: "B", taskDescription: "", dependsOn: [0], acceptanceCriteria: [] },
    ]);
    expect(order).toBeNull();
  });
});

describe("buildConsolidation + render", () => {
  it("环回退: orderIsFallback=true 且执行顺序为原序", () => {
    const parsed = parseConsolidation(VALID_LLM_OUTPUT, REQS)!;
    const c = buildConsolidation("s", parsed.items, parsed.designDoc, 1);
    expect(c.orderIsFallback).toBe(false);
    // 依赖 [0,1] 的登录优化必须排在 0、1 之后
    expect(c.executionOrder.indexOf(2)).toBeGreaterThan(c.executionOrder.indexOf(0));
    expect(c.executionOrder.indexOf(2)).toBeGreaterThan(c.executionOrder.indexOf(1));
  });

  it("渲染含任务数/合并理由/冲突/缺信息/确认提示", () => {
    const parsed = parseConsolidation(VALID_LLM_OUTPUT, REQS)!;
    const text = renderConsolidation(buildConsolidation("s", parsed.items, parsed.designDoc, 1));
    expect(text).toContain("共 3 个任务");
    expect(text).toContain("合并：req_b 与 req_c 都关于导出");
    expect(text).toContain("⚠ 冲突待拍板");
    expect(text).toContain("❓ 缺信息");
    expect(text).toContain("回复「确认」");
  });
});
