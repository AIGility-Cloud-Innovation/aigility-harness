/**
 * YAML 工作流驱动器单测: 解析 / 校验 / 沿边执行 / 条件分支 / 容错
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowYaml,
  loadWorkflowFile,
  YamlWorkflow,
} from "./workflow-driver.js";

interface St {
  task: string;
  executor?: string;
  done?: string;
}

const LINEAR_YAML = `
workflow:
  name: linear
  entry_point: a
  nodes:
    a: { type: function_node, function_ref: fnA }
    b: { type: function_node, function_ref: fnB }
  flow:
    edges:
      - { from: a, to: b }
      - { from: b, to: __end__ }
`;

const ROUTING_YAML = `
workflow:
  name: routing
  entry_point: classify
  nodes:
    classify: { type: function_node, function_ref: classify }
    content: { type: llm_node, system_prompt: "p" }
    human: { type: function_node, function_ref: mark_open }
  flow:
    edges:
      - { from: content, to: __end__ }
      - { from: human, to: __end__ }
    conditional_edges:
      - from: classify
        condition: route_by_executor
        branches:
          - { condition: content, to: content }
          - { condition: human, to: human }
`;

describe("parseWorkflowYaml / loadWorkflowFile", () => {
  it("解析合法 YAML", () => {
    const doc = parseWorkflowYaml(LINEAR_YAML);
    expect(doc.name).toBe("linear");
    expect(Object.keys(doc.nodes)).toEqual(["a", "b"]);
  });

  it("缺顶层 workflow 段时抛错", () => {
    expect(() => parseWorkflowYaml("foo: bar\n")).toThrow(/workflow/);
  });

  it("从文件路径加载", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const p = join(dir, "w.yaml");
    writeFileSync(p, LINEAR_YAML, "utf-8");
    expect(loadWorkflowFile(p).name).toBe("linear");
  });
});

describe("YamlWorkflow.validate", () => {
  it("干净的图无 errors", () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(ROUTING_YAML));
    wf.registerNode("classify", () => ({ executor: "content" }));
    wf.registerNode("mark_open", () => {});
    wf.registerNode("content", () => {});
    wf.registerCondition("route_by_executor", (s) => s.executor ?? "");
    expect(wf.validate().errors).toEqual([]);
  });

  it("边指向未声明节点 / 条件函数未注册 → errors", () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(ROUTING_YAML));
    const v = wf.validate();
    expect(v.errors.some((e) => e.includes("route_by_executor"))).toBe(true);
    expect(v.warnings.some((w) => w.includes("content"))).toBe(true);
  });
});

describe("YamlWorkflow.run", () => {
  const makeLinear = () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(LINEAR_YAML));
    wf.registerNode("fnA", () => ({ executor: "a-out" }));
    wf.registerNode("fnB", (s) => ({ done: `${s.task}+${s.executor}` }));
    return wf;
  };

  it("线性链按序执行并合并增量, 到 __end__ 收束", async () => {
    const r = await makeLinear().run({ task: "t" });
    expect(r.ok).toBe(true);
    expect(r.path).toEqual(["a", "b"]);
    expect(r.state).toEqual({ task: "t", executor: "a-out", done: "t+a-out" });
  });

  it("条件边按条件函数返回值分流", async () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(ROUTING_YAML));
    wf.registerNode("classify", (s) => ({ executor: s.task }));
    wf.registerNode("content", () => ({ done: "llm" }));
    wf.registerNode("mark_open", () => ({ done: "open" }));
    wf.registerCondition("route_by_executor", (s) => s.executor ?? "");

    const r1 = await wf.run({ task: "content" });
    expect(r1.ok).toBe(true);
    expect(r1.path).toEqual(["classify", "content"]);
    expect(r1.state.done).toBe("llm");

    const r2 = await wf.run({ task: "human" });
    expect(r2.path).toEqual(["classify", "human"]);
    expect(r2.state.done).toBe("open");
  });

  it("分支未命中 → ok:false + 明确错误", async () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(ROUTING_YAML));
    wf.registerNode("classify", () => ({ executor: "docx" }));
    wf.registerNode("content", () => {});
    wf.registerNode("mark_open", () => {});
    wf.registerCondition("route_by_executor", (s) => s.executor ?? "");
    const r = await wf.run({ task: "t" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("分支未命中");
  });

  it("节点函数抛错 → ok:false, state 保留已合并部分", async () => {
    const wf = new YamlWorkflow<St>(parseWorkflowYaml(LINEAR_YAML));
    wf.registerNode("fnA", () => ({ executor: "ok" }));
    wf.registerNode("fnB", () => {
      throw new Error("boom");
    });
    const r = await wf.run({ task: "t" });
    expect(r.ok).toBe(false);
    expect(r.state.executor).toBe("ok");
    expect(r.errors[0]).toContain("boom");
  });

  it("环路触发步数保护", async () => {
    const doc = parseWorkflowYaml(`
workflow:
  name: cycle
  entry_point: a
  nodes:
    a: { type: function_node }
    b: { type: function_node }
  flow:
    edges:
      - { from: a, to: b }
      - { from: b, to: a }
`);
    const wf = new YamlWorkflow<St>(doc);
    wf.registerNode("a", () => {});
    wf.registerNode("b", () => {});
    const r = await wf.run({ task: "t" }, { maxSteps: 8 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("环路");
  });
});
