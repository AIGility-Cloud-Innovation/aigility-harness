/**
 * coder 角色单测 — @persona/coder (编码教练: 分步引导设计)
 *
 * 验证:
 *   1. 服务定义归属 Persona 层且 id 正确, 名称不含实现名
 *   2. Provider 绑定同一服务定义, manifest provides/consumes 正确
 *   3. execute: 委托 @orchestration/guided-design 并透传阶段字段/状态
 *   4. execute: 工作流失败时如实反馈错误
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
  it("服务定义归属 Persona 层且 id 正确", () => {
    expect(coderService.id).toBe("@persona/coder");
    expect(coderService.layer).toBe(LayerId.Persona);
    expect(coderService.version).toBe("1.0.0");
  });

  it("角色名不含实现名, 描述体现教练引导", () => {
    expect(coderService.id).not.toMatch(/codex|claude|opencode|guided-design/i);
    expect(coderService.description).toContain("编码教练");
  });

  it("Provider 绑定同一服务定义", () => {
    expect(coderProvider.service).toBe(coderService);
  });
});

describe("coder execute", () => {
  it("委托 guided-design 工作流并透传阶段字段与会话状态", async () => {
    const calls: unknown[] = [];
    const ctx = mockContext((async (ref: { id?: string }, req: unknown) => {
      calls.push({ ref: ref.id, req });
      return ok({
        result: "已记录。第 2 阶段请列出功能清单。",
        phase: 2, phase_count: 5, phase_title: "功能清单", progress: "1/5",
        done: false,
        session_state: { phase: 2, answers: { 1: "给班里做个记账本" } },
      });
    }) as SeamContext["call"]);

    const r = await coderProvider.execute(
      { user_input: "我想给班里做个记账本", session_state: { phase: 1 } },
      ctx,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.length).toBe(1);
    expect((calls[0] as { ref?: string }).ref).toBe("@orchestration/guided-design");
    // 用户输入与会话状态透传给工作流
    const req = (calls[0] as { req?: { user_input?: string; session_state?: { phase?: number } } }).req;
    expect(req?.user_input).toBe("我想给班里做个记账本");
    expect(req?.session_state?.phase).toBe(1);
    // 阶段字段原样透出
    expect(r.value.agent_name).toBe("编码教练");
    expect(r.value.phase).toBe(2);
    expect(r.value.phase_title).toBe("功能清单");
    expect(r.value.progress).toBe("1/5");
    expect(r.value.done).toBe(false);
    expect(r.value.session_state?.phase).toBe(2);
    expect(r.value.response).toContain("功能清单");
  });

  it("done 时透出 final_prompt", async () => {
    const ctx = mockContext((async () =>
      ok({
        result: "好的，完整提示词如下。", done: true,
        final_prompt: "做一个班级记账本…", phase: 5, phase_count: 5,
        phase_title: "确认与出提示词", progress: "5/5",
        session_state: { phase: 5, answers: {} },
      })) as SeamContext["call"]);

    const r = await coderProvider.execute({ user_input: "确认，出提示词" }, ctx);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.done).toBe(true);
    expect(r.value.final_prompt).toContain("班级记账本");
  });

  it("工作流失败时如实反馈错误", async () => {
    const ctx = mockContext((async () =>
      err("guided-design unreachable")) as SeamContext["call"]);

    const r = await coderProvider.execute({ user_input: "开始" }, ctx);

    expect(r.ok).toBe(true); // 角色不抛错, 反馈失败原因
    if (!r.ok) return;
    expect(r.value.response).toContain("任务未完成");
    expect(r.value.response).toContain("guided-design unreachable");
  });
});
