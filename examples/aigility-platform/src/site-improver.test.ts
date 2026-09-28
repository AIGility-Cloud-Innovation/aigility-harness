/**
 * 平台改进专员（site-improver）单测 —— 决策解析 + 一轮对话编排
 *
 * LLM 与任务落板均用假实现注入，不触真上游：
 *   - ctx.call 按 Seam 服务 id 分发（timem 记忆节点抛错/成功两路都覆盖）
 *   - fileTask 注入假 createTask，断言 executor=code / createdBy 透传
 */

import { describe, expect, it, afterEach } from "vitest";
import type { SeamContext } from "@aigility-harness/core";
import type { TaskRow } from "./platform.js";

import { improverTurn, parseImproverDecision, setTaskFiledHook } from "./site-improver.js";

// ── 假 SeamContext：按服务 id 分发 ────────────────────────────────

type CallArgs = { id: string };

function makeCtx(opts: {
  llmText?: string;
  llmError?: boolean;
  memoryResults?: string[];
}): SeamContext {
  return {
    sessionId: "sess-test",
    traceId: "trace-test",
    emit: () => undefined,
    call: async (ref: unknown) => {
      const id = (ref as CallArgs).id;
      if (id === "@cognitive/llm-inference") {
        if (opts.llmError) return { ok: false, error: "llm down" };
        return { ok: true, value: { text: opts.llmText ?? "" } };
      }
      if (id === "@action/timem-memory") {
        if (opts.memoryResults) throw new Error("timem down");
        return { ok: true, value: { ok: true, results: [{ content: "此前想把首页标题改小" }] } };
      }
      if (id === "@action/timem-memory-write") return { ok: true, value: { ok: true } };
      return { ok: false, error: `unexpected service ${id}` };
    },
  } as unknown as SeamContext;
}

// ── 假 createTask 工厂：每个测试独立记录调用 ─────────────────────

function makeFakeFileTask() {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (t: Record<string, unknown>) => {
    calls.push(t);
    // improverTurn 只消费 id 并把整行透传给钩子, 其余字段补齐仅为满足 TaskRow
    return {
      id: "task-12345678-aaaa", title: t.title, detail: t.detail ?? "", executor: t.executor,
      status: "open", priority: t.priority ?? "中", createdBy: t.createdBy ?? "", createdAt: "", updatedAt: "",
    } as unknown as TaskRow;
  };
  return { fn, calls };
}

// ── parseImproverDecision ────────────────────────────────────────

describe("parseImproverDecision", () => {
  it("解析纯 JSON chat 决策", () => {
    const d = parseImproverDecision('{"action":"chat","reply":"您好"}');
    expect(d).toEqual({ action: "chat", reply: "您好" });
  });

  it("容忍代码围栏与前后缀文本", () => {
    const d = parseImproverDecision('好的：\n```json\n{"action":"chat","reply":"明白了"}\n```');
    expect(d?.action).toBe("chat");
    expect(d?.reply).toBe("明白了");
  });

  it("解析 file_task 决策（含标题/详情/优先级）", () => {
    const d = parseImproverDecision(
      '{"action":"file_task","title":"首页标题改小","detail":"【现状】过大","priority":"中","reply":"已记录"}',
    );
    expect(d?.action).toBe("file_task");
    expect(d?.title).toBe("首页标题改小");
    expect(d?.priority).toBe("中");
  });

  it("file_task 缺标题时返回 null（不可执行）", () => {
    expect(parseImproverDecision('{"action":"file_task","reply":"好"}')).toBeNull();
  });

  it("非法 JSON 返回 null", () => {
    expect(parseImproverDecision("这不是 JSON")).toBeNull();
    expect(parseImproverDecision('{"action":"unknown"}')).toBeNull();
  });
});

// ── improverTurn ─────────────────────────────────────────────────

describe("improverTurn", () => {
  it("chat 决策：直接回复, 不建任务", async () => {
    const { fn, calls } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmText: '{"action":"chat","reply":"请问想改哪个页面？"}' }),
      { user_input: "我想改一下网站", session_id: "s-chat" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(false);
    expect(r.response).toBe("请问想改哪个页面？");
    expect(calls).toHaveLength(0);
  });

  it("file_task 决策：落任务板 executor=code, 回复带任务编号", async () => {
    const { fn, calls } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({
        llmText:
          '{"action":"file_task","title":"任务板筛选加上状态","detail":"【现状】无筛选","priority":"低","reply":"收到，这就安排。"}',
      }),
      { user_input: "任务板加个状态筛选", user_key: "boss@aigility.local", session_id: "s-file" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(true);
    expect(r.task_id).toBe("task-12345678-aaaa");
    expect(r.response).toContain("任务板筛选加上状态");
    expect(r.response).toContain("task-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "任务板筛选加上状态",
      executor: "code",
      priority: "低",
      createdBy: "boss@aigility.local",
    });
  });

  it("LLM 失败时诚实降级, 不建任务", async () => {
    const { fn, calls } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmError: true }),
      { user_input: "改一下首页", session_id: "s-err" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(false);
    expect(r.response).toContain("暂时无法处理");
    expect(calls).toHaveLength(0);
  });

  it("TiMEM 记忆不可用不阻塞对话", async () => {
    const { fn } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmText: '{"action":"chat","reply":"ok"}', memoryResults: ["x"] }),
      { user_input: "在吗", session_id: "s-mem" },
      { fileTask: fn },
    );
    expect(r.response).toBe("ok");
  });

  it("LLM 输出非法 JSON 时按纯文本聊天兜底", async () => {
    const { fn } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmText: "这句话没有 JSON 结构" }),
      { user_input: "随便聊聊", session_id: "s-fallback" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(false);
    expect(r.response).toBe("这句话没有 JSON 结构");
  });

  it("落任务后触发 taskFiled 钩子 (自动派发执行器)", async () => {
    const hooked: string[] = [];
    setTaskFiledHook((t) => hooked.push(t.id));
    const { fn } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmText: '{"action":"file_task","title":"加个按钮","reply":"收到"}' }),
      { user_input: "给任务板加个按钮", session_id: "s-hook" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(true);
    expect(hooked).toEqual([r.task_id]);
  });

  it("钩子抛异常不影响回复 (任务已在板上)", async () => {
    setTaskFiledHook(() => {
      throw new Error("dispatch exploded");
    });
    const { fn } = makeFakeFileTask();
    const r = await improverTurn(
      makeCtx({ llmText: '{"action":"file_task","title":"改个文案","reply":"收到"}' }),
      { user_input: "改一下首页文案", session_id: "s-hook-err" },
      { fileTask: fn },
    );
    expect(r.filed).toBe(true);
    expect(r.response).toContain("已生成任务");
  });

  afterEach(() => {
    setTaskFiledHook(null);
  });
});
