import { describe, it, expect } from "vitest";
import { extractProjectToken, resolveProjectRef, isAgentExecutor } from "./review-aware.js";

// 2026-10-07 句式扩展的回归：真实事故「R42 项目是 timem_console_frontend」
// 旧正则只认「归属(项目)是」，用户明明说了项目却被当补充材料、机器人仍回「还差归属」。
describe("review-aware extractProjectToken — 归属句式", () => {
  it("「项目是 X」——R42 事故句式", () => {
    expect(extractProjectToken("R42 项目是 timem_console_frontend")).toBe("timem_console_frontend");
    // 2026-10-12 三位短码：R100 不得被 \d{2} 截成 R10（剥离失败会把「0」误进归属）
    expect(extractProjectToken("R100 项目是 timem_console_frontend")).toBe("timem_console_frontend");
    expect(extractProjectToken("R101 归属 space")).toBe("space");
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

  // 2026-10-08 四连败回归（引导词后紧跟 R 码，R 码曾被当成归属值吞掉）
  it("「任务归属 R42 timem-ai/timem_console_frontend」——R 码不再吞掉归属值", () => {
    expect(extractProjectToken("任务归属 R42 timem-ai/timem_console_frontend")).toBe(
      "timem-ai/timem_console_frontend",
    );
  });

  it("「任务归属 R42 console」", () => {
    expect(extractProjectToken("任务归属 R42 console")).toBe("console");
  });

  it("「任务归属 R45 timem-ai/timem_console_frontend」", () => {
    expect(extractProjectToken("任务归属 R45 timem-ai/timem_console_frontend")).toBe(
      "timem-ai/timem_console_frontend",
    );
  });

  it("无归属要素 → undefined", () => {
    expect(extractProjectToken("R08 执行人 张三")).toBeUndefined();
    expect(extractProjectToken("R09 这条先放着")).toBeUndefined();
  });
});

// 仓库直配（-/_ 归一化 + 唯一命中）：对照 config/project-registry.json 真实登记
describe("review-aware resolveProjectRef — 仓库名模糊匹配", () => {
  it("全名小写直配（R45 事故写法）", () => {
    expect(resolveProjectRef("timem-ai/timem_console_frontend")).toEqual({
      repo: "TiMEM-AI/timem_console_frontend",
      candidates: ["TiMEM-AI/timem_console_frontend"],
    });
  });

  it("连字符写法归一化后同样命中（R42 事故写法）", () => {
    expect(resolveProjectRef("timem-ai/timem-console-frontend")?.repo).toBe(
      "TiMEM-AI/timem_console_frontend",
    );
  });

  it("短片段 console 唯一命中", () => {
    expect(resolveProjectRef("console")?.repo).toBe("TiMEM-AI/timem_console_frontend");
  });

  it("原有别名 opc 保持命中", () => {
    expect(resolveProjectRef("opc")).toEqual({
      repo: "AIGility-Cloud-Innovation/nx-telecom-opc-platform",
      candidates: ["AIGility-Cloud-Innovation/nx-telecom-opc-platform"],
    });
  });

  it("宽泛 token 多命中 → 不猜", () => {
    const r = resolveProjectRef("timem");
    expect(r.repo).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(1);
  });
});

// 执行人 = 编码代理（2026-10-08）："执行人 agent" 是让 agent 直接做的合法表达
describe("review-aware isAgentExecutor — 编码代理执行人", () => {
  it("agentd/agent/AI/智能体/编码代理 都是编码代理执行人（agentd 2026-10-12 补：负责人实测『安排执行人 agentd』被当人名）", () => {
    for (const t of ["agentd", "agent", "Agent", "AI", "ai", "智能体", "编码代理", " AI "]) {
      expect(isAgentExecutor(t)).toBe(true);
    }
  });

  it("人类姓名不是编码代理执行人", () => {
    for (const t of ["张三", "yuxuanqing", "吉翰云", "agents", "代理服务器"]) {
      expect(isAgentExecutor(t)).toBe(false);
    }
  });
});
