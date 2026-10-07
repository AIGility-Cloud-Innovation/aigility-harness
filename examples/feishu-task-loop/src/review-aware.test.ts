import { describe, it, expect } from "vitest";
import { extractProjectToken } from "./review-aware.js";

// 2026-10-07 句式扩展的回归：真实事故「R42 项目是 timem_console_frontend」
// 旧正则只认「归属(项目)是」，用户明明说了项目却被当补充材料、机器人仍回「还差归属」。
describe("review-aware extractProjectToken — 归属句式", () => {
  it("「项目是 X」——R42 事故句式", () => {
    expect(extractProjectToken("R42 项目是 timem_console_frontend")).toBe("timem_console_frontend");
  });

  it("「仓库是 X」", () => {
    expect(extractProjectToken("R07 仓库是 nx-telecom-opc-platform")).toBe("nx-telecom-opc-platform");
  });

  it("「归属 X」原有句式保持", () => {
    expect(extractProjectToken("R01 归属 opc")).toBe("opc");
  });

  it("「归属项目：X」复合词不被拆坏", () => {
    expect(extractProjectToken("R03 归属项目：太忆平台")).toBe("太忆平台");
    expect(extractProjectToken("R04 归属仓库 nx")).toBe("nx");
  });

  it("「项目为 X」", () => {
    expect(extractProjectToken("R05 项目为 video")).toBe("video");
  });

  it("org/repo 全名（含 /）整段捕获", () => {
    expect(extractProjectToken("任务归属 TiMEM-AI/timem-platform-backend")).toBe(
      "TiMEM-AI/timem-platform-backend",
    );
  });

  it("无归属要素 → undefined", () => {
    expect(extractProjectToken("R08 执行人 张三")).toBeUndefined();
    expect(extractProjectToken("R09 这条先放着")).toBeUndefined();
  });
});
