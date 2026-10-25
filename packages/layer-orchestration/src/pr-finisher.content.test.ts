/**
 * diffByContent 回归测试（2026-10-25 事故）：
 * 派发前已有改动的同一文件，本轮内容变化必须识别为交付；
 * 旧实现只比路径名 → 整轮 +181/-10 被判「无新改动」。
 */
import { describe, it, expect } from "vitest";
import { diffByContent, diffPaths } from "./pr-finisher.js";

describe("diffByContent", () => {
  it("同一路径内容变了 → 算本轮改动（旧实现漏判的那类）", () => {
    const now = { "app/finance.py": "aaa", "tests/t.py": "bbb" };
    const pre = { "app/finance.py": "old", "tests/t.py": "bbb" };
    expect(diffByContent(now, pre, ["app/finance.py", "tests/t.py"])).toEqual(["app/finance.py"]);
  });

  it("路径新增（派发前不存在）→ 算改动", () => {
    const now = { "src/new.ts": "x" };
    expect(diffByContent(now, {}, [])).toEqual(["src/new.ts"]);
  });

  it("内容和路径都没变 → 不算改动", () => {
    const now = { "a.ts": "same" };
    const pre = { "a.ts": "same" };
    expect(diffByContent(now, pre, ["a.ts"])).toEqual([]);
  });

  it("无哈希快照（旧任务）→ 退回路径比较语义", () => {
    const now = { "a.ts": "1", "b.ts": "2" };
    expect(diffByContent(now, undefined, ["a.ts"])).toEqual(["b.ts"]);
  });

  it("对照：旧 diffPaths 对内容变化视而不见（证明修的是真问题）", () => {
    expect(diffPaths(["app/finance.py"], ["app/finance.py"])).toEqual([]);
  });
});
