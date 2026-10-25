/**
 * obstacle-analyst 单测：归因解析/审核门净化/落卡幂等/降级归因。
 * 纯内存 TaskRegistry（无 filePath），LLM 与建卡均为注入桩。
 */
import { describe, it, expect } from "vitest";
import { TaskRegistry } from "./task-registry.js";
import {
  extractFailureMember, sanitizeForReviewGate, parseObstacleAnalysis, fallbackObstacleAnalysis,
  buildObstacleMessages, composeFollowUp, runObstacleAnalyst,
  type ObstacleLlm, type ObstacleAnalysis,
} from "./obstacle-analyst.js";

const GOOD_LLM_TEXT = JSON.stringify({
  category: "模型网关",
  key_factors: ["网关无 deepseek-flash 别名", "上游 404 未映射"],
  resolution: "在 litellm 增加别名 deepseek-flash → deepseek-v4.1-flash 并重启网关",
  prevention: "新增调用方先经来源节点页核对别名",
  suggested_executor: "运维",
  confidence: "high",
});

const stubLlm = (text: string): ObstacleLlm => async () => ({ ok: true, value: { text } });
const failLlm: ObstacleLlm = async () => ({ ok: false, error: "gateway down" });

/** 造一个已失败的台账任务（模拟 worker-team 失败终态） */
function seedFailedTask(reg: TaskRegistry, over: Partial<Parameters<TaskRegistry["adopt"]>[0]> = {}) {
  const rec = reg.adopt({
    title: "【agent】[TiMEM-AI/timem_frontend] 修复体验中心图谱页滚动",
    description: "目标：修复图谱页同屏滚动。\n执行者：agent",
    status: "running",
    origin: { provider: "feishu-task", guid: "card-orig-1" },
    projectRef: "TiMEM-AI/timem_frontend",
    ...over,
  });
  reg.update(rec.uid, { note: "[worker-team/codex] 失败：codex-agent: HTTP_404 Invalid model name deepseek-flash" });
  reg.transition(rec.uid, "failed", "running");
  return reg.get(rec.uid)!;
}

describe("extractFailureMember", () => {
  it("从 [member] 前缀提取成员", () => {
    expect(extractFailureMember("[codex] 执行失败 → timeout")).toBe("codex");
    expect(extractFailureMember("[claude-code] 收尾失败 → x")).toBe("claude-code");
  });
  it("无前缀回退 unknown", () => {
    expect(extractFailureMember("执行失败")).toBe("unknown");
  });
});

describe("sanitizeForReviewGate", () => {
  it("执行者标记被改写为执行方（防 plan-gate 自动放行）", () => {
    const out = sanitizeForReviewGate("建议执行者：agent 尽快处理");
    expect(out).not.toMatch(/执行者[:：]/);
    expect(out).toContain("执行方:agent");
    // plan-gate 的 agentDecided 判定用同一正则，必须不命中
    expect(/执行者[:：]\s*agent\b/i.test(out)).toBe(false);
  });
});

describe("parseObstacleAnalysis", () => {
  it("解析纯 JSON 输出", () => {
    const a = parseObstacleAnalysis(GOOD_LLM_TEXT)!;
    expect(a.category).toBe("模型网关");
    expect(a.key_factors).toHaveLength(2);
    expect(a.suggested_executor).toBe("运维");
  });
  it("容忍前后缀噪声（思考文本包裹 JSON）", () => {
    const a = parseObstacleAnalysis(`分析如下：\n${GOOD_LLM_TEXT}\n以上。`)!;
    expect(a.category).toBe("模型网关");
  });
  it("非法类别/缺失字段逐项兜底或整体拒绝", () => {
    expect(parseObstacleAnalysis('{"category":"不存在的类别","key_factors":["x"],"resolution":"y"}')!.category).toBe("其他");
    expect(parseObstacleAnalysis('{"category":"其他","key_factors":[],"resolution":"y"}')).toBeNull();
    expect(parseObstacleAnalysis("完全不是 JSON")).toBeNull();
  });
});

describe("composeFollowUp", () => {
  it("标题带【障碍修复】与仓库前缀；描述含审核指引且无执行者标记", () => {
    const analysis: ObstacleAnalysis = {
      category: "模型网关", key_factors: ["别名缺失"], resolution: "加别名并重启",
      suggested_executor: "运维", confidence: "high",
    };
    const follow = composeFollowUp({
      failed: { uid: "tsk_abc123456789", title: "【agent】[TiMEM-AI/timem_frontend] 修复图谱页", projectRef: "TiMEM-AI/timem_frontend" },
      failure: { member: "codex", error: "HTTP_404" },
      analysis,
    });
    expect(follow.title).toMatch(/^【障碍修复】\[TiMEM-AI\/timem_frontend\]/);
    expect(follow.description).toContain("障碍类别：模型网关");
    expect(follow.description).toContain("解决方法：加别名并重启");
    expect(follow.description).not.toMatch(/执行者[:：]/);
    expect(follow.description).toContain("人工审核");
  });
});

describe("runObstacleAnalyst", () => {
  it("全链路：归因 → 建卡 → 台账落修复任务（planned + related 回链 + origin=卡）", async () => {
    const reg = new TaskRegistry();
    const failed = seedFailedTask(reg);
    let cardPayload: { title: string; description: string } | undefined;
    const r = await runObstacleAnalyst({
      registry: reg, failedUid: failed.uid,
      failure: { member: "codex", error: "执行失败 → HTTP_404 Invalid model deepseek-flash" },
      llm: stubLlm(GOOD_LLM_TEXT),
      createCard: async (follow) => { cardPayload = follow; return { guid: "card-fix-1", url: "https://x/card-fix-1" }; },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.analysis.category).toBe("模型网关");
    expect(r.value.degraded).toBeFalsy();
    const followUp = reg.findByExternal("feishu-task", "card-fix-1")!;
    expect(followUp).toBeTruthy();
    expect(followUp.status).toBe("planned");
    expect(followUp.links["obstacle-source"]?.guid).toBe(failed.uid);
    expect(followUp.projectRef).toBe("TiMEM-AI/timem_frontend");
    expect(cardPayload!.title).toContain("障碍修复");
    // 失败任务 note 追加归因摘要（保留现场）
    expect(reg.get(failed.uid)!.note).toContain("障碍分析：模型网关");
    expect(reg.get(failed.uid)!.note).toContain("worker-team/codex");
  });

  it("幂等：同失败任务已有非终态修复卡 → 跳过建卡", async () => {
    const reg = new TaskRegistry();
    const failed = seedFailedTask(reg);
    let calls = 0;
    const run = () => runObstacleAnalyst({
      registry: reg, failedUid: failed.uid,
      failure: { member: "codex", error: "x" },
      llm: stubLlm(GOOD_LLM_TEXT),
      createCard: async () => { calls++; return { guid: `card-fix-${calls}` }; },
    });
    const first = await run();
    expect(first.ok && first.value.uid).toBeTruthy();
    const second = await run();
    expect(second.ok && second.value.skipped).toBe("已有非终态修复卡");
    expect(calls).toBe(1); // 建卡器未被再次调用
  });

  it("LLM 失败 → 降级归因仍落卡（分析链不中断）", async () => {
    const reg = new TaskRegistry();
    const failed = seedFailedTask(reg);
    const r = await runObstacleAnalyst({
      registry: reg, failedUid: failed.uid,
      failure: { member: "codex", error: "timeout 1800000ms" },
      llm: failLlm,
      createCard: async () => ({ guid: "card-fix-degraded" }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degraded).toBe(true);
    expect(r.value.analysis.suggested_executor).toBe("人工");
    const followUp = reg.findByExternal("feishu-task", "card-fix-degraded")!;
    expect(followUp.description).toContain("自动归因不可用");
  });

  it("建卡器返回 undefined → 只归因（note 更新），不落修复任务", async () => {
    const reg = new TaskRegistry();
    const failed = seedFailedTask(reg);
    const r = await runObstacleAnalyst({
      registry: reg, failedUid: failed.uid,
      failure: { member: "codex", error: "x" },
      llm: stubLlm(GOOD_LLM_TEXT),
      createCard: async () => undefined,
    });
    expect(r.ok && r.value.uid).toBeUndefined();
    expect(reg.get(failed.uid)!.note).toContain("障碍分析：");
    expect(reg.list({ status: ["planned"] }).filter((t) => t.uid !== failed.uid)).toHaveLength(0);
  });

  it("未知任务 → err", async () => {
    const reg = new TaskRegistry();
    const r = await runObstacleAnalyst({
      registry: reg, failedUid: "tsk_nope", failure: { member: "x", error: "y" }, llm: stubLlm("{}"),
    });
    expect(r.ok).toBe(false);
  });
});

describe("buildObstacleMessages", () => {
  it("现场材料齐备且经审核门净化", () => {
    const msgs = buildObstacleMessages({
      task: { uid: "tsk_a", title: "t", description: "执行者：agent 修复", projectRef: "o/r", note: "n" },
      failure: { member: "codex", error: "boom" },
      siblingFailures: [{ uid: "tsk_b9", note: "同类失败" }],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("归属仓库：o/r");
    expect(msgs[1].content).toContain("执行方:agent"); // 已净化
    expect(msgs[1].content).toContain("同类失败");
    expect(msgs[1].content).not.toMatch(/执行者[:：]/);
  });
});

describe("fallbackObstacleAnalysis", () => {
  it("降级要素完整", () => {
    const a = fallbackObstacleAnalysis({ member: "codex", error: "HTTP_500" });
    expect(a.category).toBe("其他");
    expect(a.suggested_executor).toBe("人工");
    expect(a.confidence).toBe("low");
    expect(a.key_factors[0]).toContain("HTTP_500");
  });
});
