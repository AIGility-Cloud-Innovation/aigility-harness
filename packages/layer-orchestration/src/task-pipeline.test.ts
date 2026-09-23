import { describe, it, expect } from "vitest";
import {
  normalizeTitle,
  jaccard,
  parseCandidateTasks,
  buildJudgeMessages,
  filterDuplicates,
} from "./task-pipeline.js";

describe("normalizeTitle / jaccard", () => {
  it("归一化去标点压空白", () => {
    expect(normalizeTitle("修复：登录页 白屏！")).toBe("修复 登录页 白屏");
  });

  it("完全一致 → 1，无关 → 0", () => {
    expect(jaccard("修复登录白屏", "修复 登录 白屏")).toBe(1);
    expect(jaccard("修复登录白屏", "新增导出功能")).toBe(0);
  });

  it("部分重叠介于 0-1", () => {
    const s = jaccard("修复登录页白屏问题", "登录页 白屏 报错");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("parseCandidateTasks", () => {
  it("解析裸 JSON 数组", () => {
    const out = parseCandidateTasks(
      `[{"title":"修复登录白屏","priority":"P1","repo":"TiMEM-Space","reason":"明确 bug"}]`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe("P1");
    expect(out[0].repo).toBe("TiMEM-Space");
  });

  it("容忍 ```json 包裹与前后闲话", () => {
    const out = parseCandidateTasks(
      '好的，识别结果如下：\n```json\n[{"title":"加导出功能","priority":"P2"}]\n```\n以上。',
    );
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe("P2");
  });

  it("非法 priority 归为 P2；无 JSON 返回空", () => {
    expect(parseCandidateTasks('[{"title":"x","priority":"紧急"}]')[0].priority).toBe("P2");
    expect(parseCandidateTasks("没有任务")).toHaveLength(0);
  });
});

describe("buildJudgeMessages", () => {
  it("system 含仓库列表，user 带序号消息", () => {
    const msgs = buildJudgeMessages(["修一下登录", "今天天气不错"], ["TiMEM-AI/TiMEM-Space"]);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("TiMEM-AI/TiMEM-Space");
    expect(msgs[1].content).toContain("[1] 修一下登录");
    expect(msgs[1].content).toContain("[2] 今天天气不错");
  });
});

describe("filterDuplicates", () => {
  it("阈值以上判重并剔除", () => {
    const out = filterDuplicates(
      [
        { title: "修复登录页白屏", priority: "P1" },
        { title: "新增数据导出", priority: "P2" },
      ],
      ["[P1] 修复 登录页 白屏问题"],
      0.5,
    );
    // “修复登录页白屏” 与现有标题词集重叠足够 → 剔除；导出保留
    expect(out.map((o) => o.title)).toEqual(["新增数据导出"]);
  });
});
