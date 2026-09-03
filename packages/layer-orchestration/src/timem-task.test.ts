/**
 * timem-task 单测 — 三段式工作流 (classify → identify → dispatch)
 *
 * 验证:
 *   1. 服务定义归属 Orchestration 层, manifest provides timem-task
 *   2. classify 规则: 纯闲聊 → chat, 任务意图词 → task
 *   3. classify LLM 兜底: 无关键词 → 调 llm-inference, JSON 解析失败/非任务 → chat 降级
 *   4. identify 顺序: 显式 project_id 优先; 无显式 → agentd identify-project; 空 → ask
 *   5. git 校验: 归仓后非 git 仓库/无 origin → type:error, 不派发
 *   6. dispatch: create-from-message → pending_project → confirm → run → 轮询 completed
 *   7. agentd 未就绪(ENOENT) → type:error 提示执行引擎未就绪
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { LayerId, ok } from "@aigility-harness/core";
import type {
  SeamContext,
  LlmInferenceRequest,
} from "@aigility-harness/core";
import {
  timemTaskService,
  timemTaskProvider,
  timemTaskManifest,
  defaultSocketPath,
  enableTimemTask,
  classifyMessage,
  overrideTimemTaskHooks,
  resetTimemTaskHooks,
} from "./timem-task.js";

/** 最小 SeamContext 测试替身(LLM 调用可注入) */
function mockContext(llmText?: string): SeamContext {
  const impl = async (ref: { id?: string }, _req: unknown) => {
    if (ref.id === "@cognitive/llm-inference") {
      if (llmText === undefined) {
        throw new Error("llm-inference 未装配");
      }
      return ok({
        text: llmText,
        message: { role: "assistant", content: llmText },
        model: "qwen2.5:7b",
        finish_reason: "stop",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    throw new Error(`未预期的 capability: ${ref.id}`);
  };
  return {
    sessionId: "it-session",
    traceId: "it-trace",
    callerLayer: LayerId.Orchestration,
    addEffect: () => "e",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: impl as SeamContext["call"],
  };
}

interface UdsCall {
  method: string;
  path: string;
  body?: unknown;
}

function mockUds(handler: (call: Required<UdsCall>) => {
  status: number;
  body: string;
}): { calls: UdsCall[] } {
  const calls: UdsCall[] = [];
  overrideTimemTaskHooks({
    udsRequest: async (_socket, _token, method, path, body) => {
      const c: Required<UdsCall> = { method, path, body: body ?? {} };
      calls.push(c);
      return handler(c);
    },
  });
  return { calls };
}

afterEach(() => {
  resetTimemTaskHooks();
  // 还原 enableTimemTask 注入的 socket/token(避免跨测试泄漏)
  enableTimemTask({ socketPath: undefined, token: undefined });
});

describe("timem-task", () => {
  it("服务定义归属 Orchestration 层, manifest provides timem-task", () => {
    expect(timemTaskService.id).toBe("@orchestration/timem-task");
    expect(timemTaskService.layer).toBe(LayerId.Orchestration);
    expect(timemTaskManifest.provides.some((s) => s.id === timemTaskService.id)).toBe(true);
  });

  it("空 user_input 明确报错", async () => {
    const result = await timemTaskProvider.execute(
      { user_input: "   " },
      mockContext(),
    );
    expect(result.ok).toBe(false);
  });

  it("socket 路径解析: env 优先", () => {
    const orig = process.env["TIMEM_AGENTD_SOCK"];
    process.env["TIMEM_AGENTD_SOCK"] = "/tmp/custom.sock";
    try {
      expect(defaultSocketPath()).toBe("/tmp/custom.sock");
    } finally {
      if (orig === undefined) delete process.env["TIMEM_AGENTD_SOCK"];
      else process.env["TIMEM_AGENTD_SOCK"] = orig;
    }
  });
});

describe("classify 规则", () => {
  it("纯闲聊词 → chat, 不建任务", () => {
    expect(classifyMessage("你好")).toEqual({
      type: "chat",
      text: "我在的，有什么任务需要我执行吗？",
    });
    expect(classifyMessage("hi")).toEqual({ type: "chat", text: expect.any(String) });
    expect(classifyMessage("谢谢")).toEqual({ type: "chat", text: expect.any(String) });
    expect(classifyMessage("在吗")).toEqual({ type: "chat", text: expect.any(String) });
    expect(classifyMessage("辛苦了")).toEqual({ type: "chat", text: expect.any(String) });
  });

  it("任务意图词 → task", () => {
    expect(classifyMessage("帮我执行 echo hello")).toEqual({ type: "task", project: null });
    expect(classifyMessage("修复登录 bug")).toEqual({ type: "task", project: null });
    expect(classifyMessage("创建项目脚手架")).toEqual({ type: "task", project: null });
    expect(classifyMessage("跑一下测试")).toEqual({ type: "task", project: null });
  });

  it("任务意图词 + 项目名 → task 且提取 project", () => {
    expect(classifyMessage("在 gyzy_platform 项目修复 bug")).toEqual({
      type: "task",
      project: "gyzy_platform",
    });
    expect(classifyMessage("在 standalone 仓库部署服务")).toEqual({
      type: "task",
      project: "standalone",
    });
    expect(classifyMessage("在 my-repo/repo1 项目跑测试")).toEqual({
      type: "task",
      project: "my-repo/repo1",
    });
  });

  it("既无闲聊词也无任务词 → unknown(需 LLM 兜底)", () => {
    expect(classifyMessage("今天天气怎么样")).toEqual({ type: "unknown" });
    expect(classifyMessage("随便聊聊")).toEqual({ type: "unknown" });
  });
});

describe("classify LLM 兜底", () => {
  it("无关键词 → 调 llm-inference, 判定为任务并提取项目", async () => {
    const ctx = mockContext('{"is_task": true, "project": "gyzy_platform", "reason": "修复 bug"}');
    const llmCalls: unknown[] = [];
    const origCall = ctx.call;
    (ctx as { call: unknown }).call = (async (ref: { id?: string }, req: LlmInferenceRequest) => {
      llmCalls.push(req);
      return origCall(ref, req);
    }) as SeamContext["call"];

    overrideTimemTaskHooks({
      udsRequest: async (_s, _t, _m, path) => {
        if (path === "/v1/tasks/identify-project") {
          return {
            status: 200,
            body: JSON.stringify({ projectId: "standalone", rootPaths: ["/tmp"] }),
          };
        }
        if (path === "/v1/tasks/create-from-message") {
          return { status: 200, body: JSON.stringify({ id: "t-llm", status: "queued" }) };
        }
        if (path === "/v1/tasks/t-llm") {
          return { status: 200, body: JSON.stringify({ id: "t-llm", status: "completed" }) };
        }
        return { status: 200, body: "{}" };
      },
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });

    const result = await timemTaskProvider.execute(
      { user_input: "顺便问下这个接口怎么回事", user_id: "u1", session_id: "s1" },
      ctx as SeamContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("task");
    expect(llmCalls.length).toBe(1);
    const req = llmCalls[0] as LlmInferenceRequest;
    expect(req.model).toBe("qwen2.5:7b");
    expect(req.messages[0].content).toContain("is_task");
  });

  it("LLM JSON 解析失败 → 降级按非任务处理(chat)", async () => {
    const ctx = mockContext("抱歉我无法回答这个问题");
    const result = await timemTaskProvider.execute(
      { user_input: "今天天气怎么样" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("chat");
  });

  it("LLM 不可用(抛错) → 降级 chat, 不 panic", async () => {
    const ctx = mockContext(); // llmText === undefined → 抛错
    const result = await timemTaskProvider.execute(
      { user_input: "今天天气怎么样" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("chat");
  });
});

describe("identify 归仓顺序", () => {
  it("显式 project_id 优先, 仍查 rootPaths 并做 git 校验", async () => {
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({
            projectId: "from-bind",
            method: "explicit-bind",
            rootPaths: ["/tmp/tt-project-a"],
          }),
        };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        return { status: 200, body: JSON.stringify({ id: "t1", status: "queued" }) };
      }
      if (c.path === "/v1/tasks/t1/confirm-project") {
        return { status: 200, body: JSON.stringify({ id: "t1", status: "confirmed" }) };
      }
      return { status: 200, body: JSON.stringify({ id: "t1", status: "completed" }) };
    });
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });

    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug", project_id: "gyzy_platform" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("task");
    const identifyCall = calls.find((c) => c.path === "/v1/tasks/identify-project");
    expect(identifyCall).toBeDefined();
    expect(
      (identifyCall as { body?: { projectId?: string } }).body?.projectId,
    ).toBe("gyzy_platform");
  });

  it("无显式 project_id → 调 identify-project, 用返回的 projectId", async () => {
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "standalone", method: "bind", rootPaths: ["/x"] }),
        };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        return { status: 200, body: JSON.stringify({ id: "t1", status: "queued" }) };
      }
      return { status: 200, body: JSON.stringify({ id: "t1", status: "completed" }) };
    });
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });
    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug", user_id: "u1" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("task");
    const identifyCall = calls.find((c) => c.path === "/v1/tasks/identify-project") as {
      body?: { conversationId?: string; senderId?: string };
    };
    expect(identifyCall.body?.conversationId).toBe("it-session");
    expect(identifyCall.body?.senderId).toBe("u1");
  });

  it("identify-project 未识别出项目 → ask 反问归哪个仓库", async () => {
    mockUds(() => ({
      status: 200,
      body: JSON.stringify({ projectId: "", method: "none", rootPaths: [] }),
    }));
    const result = await timemTaskProvider.execute(
      { user_input: "帮我部署一下" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      type: "ask",
      text: "这个任务要归到哪个项目/仓库？",
    });
  });
});

describe("git 校验(归仓后、派发前)", () => {
  it("root 非 git 仓库 → type:error, 不派发", async () => {
    overrideTimemTaskHooks({
      gitInWorkTree: async () => false,
      gitHasOrigin: async () => true,
    });
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "bad", rootPaths: ["/tmp/not-a-repo"] }),
        };
      }
      return { status: 200, body: "{}" };
    });
    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("error");
    expect((result.value as { text: string }).text).toContain("不是有效的 git 仓库");
    expect(calls.some((c) => c.path.startsWith("/v1/tasks/create-from-message"))).toBe(false);
  });

  it("git 仓库但无 origin → type:error, 不派发", async () => {
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => false,
    });
    mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "no-origin", rootPaths: ["/tmp/git-repo"] }),
        };
      }
      return { status: 200, body: "{}" };
    });
    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("error");
    expect((result.value as { text: string }).text).toContain("未配置 origin 远程");
  });

  it("有效 git 仓库且有 origin → 正常派发", async () => {
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "good", rootPaths: ["/tmp/git-repo"] }),
        };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        return { status: 200, body: JSON.stringify({ id: "t1", status: "queued" }) };
      }
      return { status: 200, body: JSON.stringify({ id: "t1", status: "completed" }) };
    });
    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("task");
    expect(calls.some((c) => c.path === "/v1/tasks/create-from-message")).toBe(true);
  });
});

describe("dispatch 派发状态机", () => {
  it("pending_project → 自动 confirm-project → 停 pending_confirm → type:confirm（不 run）", async () => {
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "standalone", rootPaths: ["/x"] }),
        };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        return {
          status: 200,
          body: JSON.stringify({ id: "t100", status: "pending_project", pending_project: true }),
        };
      }
      if (c.path === "/v1/tasks/t100/confirm-project") {
        return { status: 200, body: JSON.stringify({ id: "t100", status: "pending_confirm" }) };
      }
      return { status: 200, body: "{}" };
    });
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });

    const result = await timemTaskProvider.execute(
      { user_input: "执行 echo hello" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ type: "confirm", taskId: "t100" });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/v1/tasks/t100/confirm-project");
    expect(paths).not.toContain("/v1/tasks/t100/run");
  });

  it("create-from-message 返回 pending_confirm → 停在待确认（不 run）→ type:confirm", async () => {
    const { calls } = mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return {
          status: 200,
          body: JSON.stringify({ projectId: "standalone", rootPaths: ["/x"] }),
        };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        return {
          status: 200,
          body: JSON.stringify({
            id: "t99",
            status: "pending_confirm",
            contextGate: { name: "confirm_prompt", value: "standalone" },
          }),
        };
      }
      return { status: 200, body: "{}" };
    });
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });
    const result = await timemTaskProvider.execute(
      { user_input: "执行 echo hello" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ type: "confirm", taskId: "t99" });
    expect(calls.some((c) => c.path === "/v1/tasks/t99/run")).toBe(false);
  });
});

describe("agentd 未就绪", () => {
  it("识别阶段 socket 不存在 → type:error 提示执行引擎未就绪", async () => {
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });
    enableTimemTask({
      socketPath: "/nonexistent/agentd.sock",
      token: "token",
    });
    const result = await timemTaskProvider.execute(
      { user_input: "修复登录 bug" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("error");
    expect((result.value as { text: string }).text).toContain("执行引擎未就绪");
  });
});
