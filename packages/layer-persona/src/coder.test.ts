/**
 * coder 角色单测 — @persona/coder
 *
 * 验证:
 *   1. 服务定义归属 Persona 层且 id/版本正确
 *   2. Provider 绑定同一服务定义, manifest provides/consumes 正确
 *   3. execute: 委托 codex-agent 并返回角色反馈
 *   4. execute: codex-agent 失败时如实反馈错误
 */
import { describe, it, expect } from "vitest";
import { LayerId, ok, err } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";
import {
  coderService,
  coderProvider,
} from "./coder.js";

/** 最小 SeamContext 测试替身 */
function mockContext(callImpl: SeamContext["call"]): SeamContext {
  return {
    sessionId: "it-coder-session",
    traceId: "it-coder-trace",
    callerLayer: LayerId.Persona,
    addEffect: () => "e",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: callImpl,
  };
}

describe("@persona/coder 契约", () => {
  it("服务定义归属 Persona 层且 id/版本正确", () => {
    expect(coderService.id).toBe("@persona/coder");
    expect(coderService.layer).toBe(LayerId.Persona);
    expect(coderService.version).toBe("1.0.0");
  });

  it("服务名不含实现名(codex)", () => {
    // 角色名与实现解耦: 换 claude-code/opencode 时角色零改动
    expect(coderService.id).not.toMatch(/codex|claude|opencode/i);
    expect(coderService.description).toContain("编码助手");
  });

  it("Provider 绑定同一服务定义", () => {
    expect(coderProvider.service).toBe(coderService);
  });
});

describe("coder execute", () => {
  it("委托 codex-agent 并返回角色反馈", async () => {
    const calls: unknown[] = [];
    const ctx = mockContext((async (ref: { id?: string }, req: unknown) => {
      calls.push({ ref: ref.id, req });
      return ok({ text: "完成：实现了排序算法", plan: "mock plan" });
    }) as SeamContext["call"]);

    const r = await coderProvider.execute(
      { user_input: "帮我写个排序算法" },
      ctx,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.length).toBe(1);
    expect((calls[0] as { ref?: string }).ref).toBe("@orchestration/codex-agent");
    // 人设提示词已拼入 prompt
    const req = (calls[0] as { req?: { prompt?: string } }).req;
    expect(req?.prompt).toContain("编码助手");
    expect(req?.prompt).toContain("帮我写个排序算法");
    // 角色反馈
    expect(r.value.response).toContain("排序算法");
    expect(r.value.agent_name).toBe("编码助手");
    expect(r.value.session_id).toBe("it-coder-session");
    expect(r.value.trace_id).toBe("it-coder-trace");
  });

  it("codex-agent 失败时如实反馈错误", async () => {
    const ctx = mockContext((async () =>
      err("LiteLLM unreachable")) as SeamContext["call"]);

    const r = await coderProvider.execute(
      { user_input: "修 bug" },
      ctx,
    );

    expect(r.ok).toBe(true); // 角色不抛错, 反馈失败原因
    if (!r.ok) return;
    expect(r.value.response).toContain("未完成");
    expect(r.value.response).toContain("LiteLLM unreachable");
  });
});