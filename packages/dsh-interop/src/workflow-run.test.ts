import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeWorkflowRunFiles,
  buildWorkflowTask,
  parseWorkflowReturnValue,
} from "./workflow-run.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "dsh-workflow-run-"));
}

describe("writeWorkflowRunFiles — 脚本/参数落盘存档", () => {
  it("写入 script.js / meta.json / args.json 三个文件，内容可回读", () => {
    const home = makeHome();
    const files = writeWorkflowRunFiles(
      home,
      "return args.items.length;",
      { name: "count-items", description: "数一数" },
      { items: ["a", "b"] },
    );
    expect(existsSync(files.scriptPath)).toBe(true);
    expect(existsSync(files.metaPath)).toBe(true);
    expect(existsSync(files.argsPath)).toBe(true);
    expect(readFileSync(files.scriptPath, "utf8")).toBe("return args.items.length;");
    expect(JSON.parse(readFileSync(files.metaPath, "utf8"))).toEqual({
      name: "count-items",
      description: "数一数",
    });
    expect(JSON.parse(readFileSync(files.argsPath, "utf8"))).toEqual({
      items: ["a", "b"],
    });
    // 存档收敛在 $DSH_HOME/workflow-runs 下
    expect(files.dir.startsWith(join(home, "workflow-runs"))).toBe(true);
  });

  it("args 省略时落盘为 {}", () => {
    const home = makeHome();
    const files = writeWorkflowRunFiles(home, "return 1;", {
      name: "x",
      description: "y",
    }, undefined);
    expect(JSON.parse(readFileSync(files.argsPath, "utf8"))).toEqual({});
  });
});

describe("buildWorkflowTask — 任务文本指向三个绝对路径", () => {
  it("包含 meta/script/args 三个文件路径与关键约束", () => {
    const files = writeWorkflowRunFiles(makeHome(), "return 1;", {
      name: "n",
      description: "d",
    }, { a: 1 });
    const task = buildWorkflowTask(files);
    expect(task).toContain(files.metaPath);
    expect(task).toContain(files.scriptPath);
    expect(task).toContain(files.argsPath);
    // 关键约束：脚本全文 verbatim、不得补 export const meta、最终回复只留 JSON
    expect(task).toContain("export const meta");
    expect(task).toContain("ONLY");
  });
});

describe("parseWorkflowReturnValue — 从最终回复提取 JSON 返回值", () => {
  it("整段即 JSON", () => {
    const r = parseWorkflowReturnValue('{ "agentsStarted": 3, "result": 42 }');
    expect(r.parsed).toBe(true);
    expect(r.value).toEqual({ agentsStarted: 3, result: 42 });
  });

  it("```json 围栏内的返回值", () => {
    const r = parseWorkflowReturnValue('前言\n```json\n{"result":[1,2]}\n```\n后记');
    expect(r.parsed).toBe(true);
    expect(r.value).toEqual({ result: [1, 2] });
  });

  it("JSON 前后混有说明文字时按最外层截取", () => {
    const r = parseWorkflowReturnValue(
      'workflow "audit" completed (3 agents.)\nReturn value:\n{"ok":true,"files":9}\ndone.',
    );
    expect(r.parsed).toBe(true);
    expect(r.value).toEqual({ ok: true, files: 9 });
  });

  it("纯文本无 JSON → parsed false", () => {
    expect(parseWorkflowReturnValue("模型叨叨了一段没有 JSON").parsed).toBe(false);
    expect(parseWorkflowReturnValue("").parsed).toBe(false);
  });
});
