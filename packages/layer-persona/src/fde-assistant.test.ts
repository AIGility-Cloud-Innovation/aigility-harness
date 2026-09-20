import { describe, it, expect } from "vitest";
import {
  fdeAssistantService,
  fdeAssistantProvider,
  manifest,
} from "./fde-assistant.js";
import type { SeamContext } from "@aigility-harness/core";

/** 最小 SeamContext mock：记录 workflow-engine 收到的请求 */
function mockCtx(calls: Array<{ refId: string; request: unknown }>): SeamContext {
  const ctx = {
    sessionId: "sess-test",
    traceId: "trace-test",
    call: async (ref: { id: string }, request: unknown) => {
      calls.push({ refId: ref.id, request });
      return { ok: true, value: { result: "基于台账快照的回答", degraded: false } };
    },
    getState: () => undefined,
    setState: () => undefined,
    emit: () => undefined,
  };
  return ctx as unknown as SeamContext;
}

describe("@persona/fde-assistant 契约", () => {
  it("服务定义归属 Persona 层", () => {
    expect(fdeAssistantService.id).toBe("@persona/fde-assistant");
    expect(fdeAssistantService.layer).toBe("persona");
  });

  it("provider 与 manifest 注册正确", () => {
    expect(fdeAssistantProvider.service).toBe(fdeAssistantService);
    expect(manifest.provides).toContain(fdeAssistantService);
    expect(manifest.consumes[0]?.id).toBe("@orchestration/workflow-engine");
  });

  it("业务快照注入 system_prompt, 记忆节点按 agent 隔离, 回复透传", async () => {
    const calls: Array<{ refId: string; request: unknown }> = [];
    const ctx = mockCtx(calls);
    const result = await fdeAssistantProvider.execute(
      {
        user_input: "现在有哪些在途线索?",
        user_key: "admin",
        business_context: "【线索】在途 2 条\n- 宁夏电信：阶段=谈判中",
        history: [{ role: "user", content: "你好" }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((result as { value?: { response?: string } }).value?.response).toBe("基于台账快照的回答");

    const wf = calls.find(c => c.refId === "@orchestration/workflow-engine");
    expect(wf).toBeTruthy();
    const req = wf!.request as { system_prompt?: string; memory?: { agent_id?: string; user_id?: string }; user_key?: string };
    expect(req.system_prompt).toContain("宁夏电信");
    expect(req.system_prompt).toContain("TiMEM 数字员工");
    expect(req.memory?.agent_id).toBe("fde-assistant");
    expect(req.memory?.user_id).toBe("admin");
    expect(req.user_key).toBe("admin");
  });

  it("编排层失败时返回友好降级文案", async () => {
    const ctx = {
      sessionId: "s",
      traceId: "t",
      call: async () => ({ ok: false, error: "workflow unavailable" }),
      getState: () => undefined,
      setState: () => undefined,
      emit: () => undefined,
    } as unknown as SeamContext;
    const result = await fdeAssistantProvider.execute({ user_input: "hi" }, ctx);
    expect(result.ok).toBe(true);
    expect((result as { value?: { response?: string } }).value?.response).toContain("暂时无法响应");
  });
});
