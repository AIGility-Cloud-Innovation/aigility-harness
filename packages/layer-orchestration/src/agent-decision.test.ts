/**
 * agent-decision 单测：决策文件契约（解析/读/写回/状态判定/清理）
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_FILE,
  parseAgentDecision,
  readAgentDecision,
  writeDecision,
  removeDecisionFile,
  isPendingDecision,
  hasConclusion,
  DECISION_RULES,
} from "./agent-decision.js";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "agent-decision-"));
}

describe("parseAgentDecision", () => {
  it("合法：question + options，首项即推荐项，defaultOption 缺省 0", () => {
    const d = parseAgentDecision('{"question":"选哪个方案？","options":["方案A","方案B"]}');
    expect(d).toMatchObject({ question: "选哪个方案？", options: ["方案A", "方案B"] });
    expect(d?.defaultOption).toBeUndefined();
  });

  it("非法：缺 question / options 空 / 非 JSON → undefined", () => {
    expect(parseAgentDecision('{"options":["a"]}')).toBeUndefined();
    expect(parseAgentDecision('{"question":"q","options":[]}')).toBeUndefined();
    expect(parseAgentDecision("不是 JSON")).toBeUndefined();
  });

  it("decision 字段随解析保留（写回后重读可见）", () => {
    const d = parseAgentDecision('{"question":"q","options":["a","b"],"decision":"b","decidedBy":"johnny"}');
    expect(d?.decision).toBe("b");
    expect(d?.decidedBy).toBe("johnny");
  });
});

describe("readAgentDecision / 判态", () => {
  it("文件不存在 → found:false", () => {
    expect(readAgentDecision(tmpCwd()).found).toBe(false);
  });

  it("非法 JSON → found:true + invalid:true", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), "{broken", "utf-8");
    const r = readAgentDecision(cwd);
    expect(r.found).toBe(true);
    expect((r as { invalid?: boolean }).invalid).toBe(true);
  });

  it("未决策合法文件 → isPendingDecision，非 hasConclusion", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a","b"]}', "utf-8");
    const r = readAgentDecision(cwd);
    expect(isPendingDecision(r)).toBe(true);
    expect(hasConclusion(r)).toBe(false);
  });

  it("已决策 → hasConclusion 且非 pending", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a","b"],"decision":"b","decidedBy":"johnny"}', "utf-8");
    const r = readAgentDecision(cwd);
    expect(isPendingDecision(r)).toBe(false);
    expect(hasConclusion(r)).toBe(true);
  });
});

describe("writeDecision", () => {
  it("写回结论：decision/decidedBy/decidedAt 落文件，重读可解析", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a","b"]}', "utf-8");
    const w = writeDecision(cwd, "b", { decidedBy: "johnny", decidedFrom: "决策 tsk_x 选 b" });
    expect(w.ok).toBe(true);
    const d = readAgentDecision(cwd);
    expect(d.found).toBe(true);
    if (d.found && d.decision) {
      expect(d.decision.decision).toBe("b");
      expect(d.decision.decidedBy).toBe("johnny");
      expect(d.decision.decidedAt).toBeTruthy();
      expect(d.decision.options).toEqual(["a", "b"]); // 原选项保留
    }
  });

  it("已决策文件重复写回 → err（防重复提交）", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a","b"],"decision":"a"}', "utf-8");
    expect(writeDecision(cwd, "b").ok).toBe(false);
  });

  it("文件不存在/空选项 → err", () => {
    expect(writeDecision(tmpCwd(), "a").ok).toBe(false);
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a"]}', "utf-8");
    expect(writeDecision(cwd, "").ok).toBe(false);
  });
});

describe("removeDecisionFile", () => {
  it("存在则删除；不存在不抛", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, DECISION_FILE), '{"question":"q","options":["a"]}', "utf-8");
    removeDecisionFile(cwd);
    expect(existsSync(join(cwd, DECISION_FILE))).toBe(false);
    expect(() => removeDecisionFile(cwd)).not.toThrow();
  });
});

describe("DECISION_RULES", () => {
  it("worker prompt 约定含决策文件与续跑语义", () => {
    expect(DECISION_RULES).toContain(".agent-decision.json");
    expect(DECISION_RULES).toContain("options");
    expect(DECISION_RULES).toContain("injected_decision");
    expect(DECISION_RULES).toContain("同一会话/线程");
  });
});
