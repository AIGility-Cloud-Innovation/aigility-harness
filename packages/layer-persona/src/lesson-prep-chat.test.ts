import { describe, it, expect } from "vitest";
import {
  lessonPrepChatService,
  lessonPrepChatProvider,
  manifest,
} from "./lesson-prep-chat.js";
import type { SeamContext } from "@aigility-harness/core";

/** 最小 SeamContext mock：记录 workflow-engine 收到的请求 */
function mockCtx(calls: Array<{ refId: string; request: unknown }>): SeamContext {
  const ctx = {
    sessionId: "sess-test",
    traceId: "trace-test",
    call: async (ref: { id: string }, request: unknown) => {
      calls.push({ refId: ref.id, request });
      return { ok: true, value: { result: "基于课程教材快照的回答", degraded: false } };
    },
    getState: () => undefined,
    setState: () => undefined,
    emit: () => undefined,
  };
  return ctx as unknown as SeamContext;
}

describe("@persona/lesson-prep-chat 契约", () => {
  it("服务定义归属 Persona 层", () => {
    expect(lessonPrepChatService.id).toBe("@persona/lesson-prep-chat");
    expect(lessonPrepChatService.layer).toBe("persona");
  });

  it("provider 与 manifest 注册正确", () => {
    expect(lessonPrepChatProvider.service).toBe(lessonPrepChatService);
    expect(manifest.provides).toContain(lessonPrepChatService);
    expect(manifest.consumes[0]?.id).toBe("@orchestration/workflow-engine");
  });

  it("课程教材快照注入 system_prompt, 记忆按 agent_id=lesson-prep + 老师邮箱隔离, 回复透传", async () => {
    const calls: Array<{ refId: string; request: unknown }> = [];
    const ctx = mockCtx(calls);
    const result = await lessonPrepChatProvider.execute(
      {
        user_input: "治安管理这一章的教案该怎么设计?",
        user_key: "wang@school.cn",
        course_context: "【课程】治安管理 (3 章 / 42 切片)\n【已有教案】第1章 ready",
        llm: { url: "http://llm.example", key: "sk-x", model: "glm-4.6" },
        history: [{ role: "user", content: "你好" }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((result as { value?: { response?: string } }).value?.response).toBe("基于课程教材快照的回答");

    const wf = calls.find(c => c.refId === "@orchestration/workflow-engine");
    expect(wf).toBeTruthy();
    const req = wf!.request as {
      system_prompt?: string;
      memory?: { agent_id?: string; user_id?: string };
      user_key?: string;
      llm?: { model?: string };
      history?: unknown[];
    };
    expect(req.system_prompt).toContain("备课助理");
    expect(req.system_prompt).toContain("治安管理");
    expect(req.memory?.agent_id).toBe("lesson-prep");
    expect(req.memory?.user_id).toBe("wang@school.cn");
    expect(req.user_key).toBe("wang@school.cn");
    expect(req.llm?.model).toBe("glm-4.6");
    expect(req.history).toHaveLength(1);
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
    const result = await lessonPrepChatProvider.execute({ user_input: "hi" }, ctx);
    expect(result.ok).toBe(true);
    expect((result as { value?: { response?: string } }).value?.response).toContain("暂时无法响应");
  });
});
