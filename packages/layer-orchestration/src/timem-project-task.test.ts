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
  timemProjectTaskService,
  timemProjectTaskProvider,
  timemTaskManifest,
  defaultSocketPath,
  enableTimemProjectTask,
  classifyMessage,
  overrideTimemTaskHooks,
  resetTimemTaskHooks,
  resetRequirementStoreForTest,
} from "./timem-project-task.js";

/** 最小 SeamContext 测试替身(LLM 调用可注入; 汇总器 prompt 可单独给响应, 支持按 user content 动态生成) */
function mockContext(
  llmText?: string,
  opts?: { consolidation?: string | ((userContent: string) => string) },
): SeamContext {
  const impl = async (ref: { id?: string }, req: unknown) => {
    if (ref.id === "@cognitive/llm-inference") {
      const messages = (req as LlmInferenceRequest).messages ?? [];
      const sys = (messages[0]?.content ?? "") as string;
      if (sys.includes("需求汇总器") && opts?.consolidation !== undefined) {
        const userContent = (messages[1]?.content ?? "") as string;
        const text = typeof opts.consolidation === "function" ? opts.consolidation(userContent) : opts.consolidation;
        return ok({
          text,
          message: { role: "assistant", content: text },
          model: "qwen2.5:7b",
          finish_reason: "stop",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
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
  // 还原 enableTimemProjectTask 注入的 socket/token(避免跨测试泄漏)
  enableTimemProjectTask({ socketPath: undefined, token: undefined });
  resetRequirementStoreForTest();
});

describe("timem-task", () => {
  it("服务定义归属 Orchestration 层, manifest provides timem-task", () => {
    expect(timemProjectTaskService.id).toBe("@orchestration/timem-project-task");
    expect(timemProjectTaskService.layer).toBe(LayerId.Orchestration);
    expect(timemTaskManifest.provides.some((s) => s.id === timemProjectTaskService.id)).toBe(true);
  });

  it("空 user_input 明确报错", async () => {
    const result = await timemProjectTaskProvider.execute(
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

    const result = await timemProjectTaskProvider.execute(
      { user_input: "顺便问下这个接口怎么回事", user_id: "u1", session_id: "s1" },
      ctx as SeamContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // E8: 无项目名的任务意图 → 进需求缓冲区(不再直接派发)
    expect(result.value.type).toBe("collected");
    expect(llmCalls.length).toBe(1);
    const req = llmCalls[0] as LlmInferenceRequest;
    expect(req.model).toBe("glm-4.6"); // 跟随 LLM_MODEL 默认, 不再写死 qwen2.5:7b
    expect(req.messages[0].content).toContain("is_task");
  });

  it("LLM JSON 解析失败 → 降级按非任务处理(chat)", async () => {
    const ctx = mockContext("抱歉我无法回答这个问题");
    const result = await timemProjectTaskProvider.execute(
      { user_input: "今天天气怎么样" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("chat");
  });

  it("LLM 不可用(抛错) → 降级 chat, 不 panic", async () => {
    const ctx = mockContext(); // llmText === undefined → 抛错
    const result = await timemProjectTaskProvider.execute(
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

    const result = await timemProjectTaskProvider.execute(
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目修复登录 bug", user_id: "u1" },
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目帮我部署一下" },
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目修复登录 bug" },
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目修复登录 bug" },
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目修复登录 bug" },
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

    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 standalone 项目执行 echo hello" },
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
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 standalone 项目执行 echo hello" },
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
    enableTimemProjectTask({
      socketPath: "/nonexistent/agentd.sock",
      token: "token",
    });
    const result = await timemProjectTaskProvider.execute(
      { user_input: "在 gyzy_platform 项目修复登录 bug" },
      mockContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("error");
    expect((result.value as { text: string }).text).toContain("执行引擎未就绪");
  });
});

// ---- 需求缓冲区工作流 (E 扩展: 缓冲 → 汇总 → 确认 → 按序执行) ----

describe("需求缓冲区工作流", () => {
  /** 全通 agentd mock: identify/create/confirm 固定成功, 任务终态由 perTask 决定 */
  function mockUds2(perTask: (taskId: string) => string) {
    let n = 0;
    return mockUds((c) => {
      if (c.path === "/v1/tasks/identify-project") {
        return { status: 200, body: JSON.stringify({ projectId: "demo", rootPaths: ["/tmp/demo"] }) };
      }
      if (c.path === "/v1/tasks/create-from-message") {
        n += 1;
        return { status: 200, body: JSON.stringify({ id: `t${n}`, status: "pending_confirm" }) };
      }
      if (c.path.includes("/confirm-prompt")) {
        return { status: 200, body: JSON.stringify({ id: `t${n}`, status: "queued" }) };
      }
      if (/^\/v1\/tasks\/t\d+$/.test(c.path)) {
        // "/v1/tasks/t1".split("/") → ["", "v1", "tasks", "t1"] → id 在下标 3
        const id = c.path.split("/")[3]!;
        return { status: 200, body: JSON.stringify({ id, status: perTask(id) }) };
      }
      return { status: 200, body: "{}" };
    });
  }

  function consolidationJson(reqIds: string[]): string {
    // 两个任务: T1(第一条需求), T2(其余需求合并, 依赖 T1)
    return JSON.stringify({
      items: [
        {
          requirement_ids: [reqIds[0]!],
          task_title: "全站深色模式",
          task_description: "实现全站深色模式, 图表配色跟随",
          depends_on: [],
          acceptance_criteria: ["可切换深浅"],
        },
        {
          requirement_ids: reqIds.slice(1),
          task_title: "导出 Excel 含头像",
          task_description: "用户列表导出 Excel 并带头像链接",
          merged_reason: "都关于导出",
          depends_on: [0],
          acceptance_criteria: ["导出含头像列"],
        },
      ],
      design_doc: "# 统一设计\n先易后难",
    });
  }

  it("E9-1: 聊天期 5 条需求 → 全部 collected, 不派发(无 UDS 调用)", async () => {
    const { calls } = mockUds(() => ({ status: 200, body: "{}" }));
    const ctx = mockContext('{"is_task": true}');
    let last: { type: string; count?: number } | null = null;
    const inputs = [
      "页面要实现深色模式",
      "开发用户列表导出 Excel 功能",
      "优化一下登录", // 无任务词 → LLM 兜底判任务
      "导出的 Excel 要带头像链接",
      "图表颜色也要跟着主题改",
    ];
    for (const t of inputs) {
      const r = await timemProjectTaskProvider.execute(
        { user_input: t, session_id: "buf-1", quiet_ms: 0 },
        ctx,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.type).toBe("collected");
      last = r.value as { type: string; count?: number };
    }
    expect(last?.count).toBe(5);
    expect(calls).toHaveLength(0); // 聊天期绝不执行
  });

  it("E9-2: 闲聊在缓冲期仍回 chat, 清单不变", async () => {
    const ctx = mockContext('{"is_task": true}');
    const r1 = await timemProjectTaskProvider.execute(
      { user_input: "开发导出功能", session_id: "buf-2", quiet_ms: 0 },
      ctx,
    );
    expect(r1.ok && r1.value.type).toBe("collected");
    const r2 = await timemProjectTaskProvider.execute(
      { user_input: "你好", session_id: "buf-2", quiet_ms: 0 },
      ctx,
    );
    expect(r2.ok && r2.value.type).toBe("chat");
  });

  it("E9-3: 「就这些了」→ 汇总单(合并理由/依赖/确认提示)", async () => {
    const ctx = mockContext('{"is_task": true}');
    const ids: string[] = [];
    for (const t of ["页面要实现深色模式", "开发用户列表导出 Excel 功能", "导出的 Excel 要带头像链接"]) {
      const r = await timemProjectTaskProvider.execute(
        { user_input: t, session_id: "buf-3", quiet_ms: 0 },
        ctx,
      );
      if (r.ok && r.value.type === "collected") ids.push(r.value.requirementId);
    }
    const cctx = mockContext('{"is_task": true}', { consolidation: consolidationJson(ids) });
    const r = await timemProjectTaskProvider.execute(
      { user_input: "就这些了", session_id: "buf-3", quiet_ms: 0 },
      cctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe("consolidation");
    const cons = r.value as { summaryText: string; version: number };
    expect(cons.version).toBe(1);
    expect(cons.summaryText).toContain("共 2 个任务");
    expect(cons.summaryText).toContain("合并：都关于导出");
    expect(cons.summaryText).toContain("依赖：全站深色模式");
    expect(cons.summaryText).toContain("回复「确认」");
  });

  it("E9-4: 确认 → 按拓扑序执行, 每任务注入统一设计+自动确认", async () => {
    const ctx = mockContext('{"is_task": true}');
    const ids: string[] = [];
    for (const t of ["页面要实现深色模式", "开发用户列表导出 Excel 功能"]) {
      const r = await timemProjectTaskProvider.execute(
        { user_input: t, session_id: "buf-4", quiet_ms: 0 },
        ctx,
      );
      if (r.ok && r.value.type === "collected") ids.push(r.value.requirementId);
    }
    const cctx = mockContext('{"is_task": true}', { consolidation: consolidationJson(ids) });
    await timemProjectTaskProvider.execute({ user_input: "就这些了", session_id: "buf-4", quiet_ms: 0 }, cctx);

    const { calls } = mockUds2(() => "completed");
    overrideTimemTaskHooks({
      gitInWorkTree: async () => true,
      gitHasOrigin: async () => true,
    });
    const r = await timemProjectTaskProvider.execute(
      { user_input: "确认", session_id: "buf-4", quiet_ms: 0 },
      mockContext('{"is_task": true}'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe("task");
    const task = r.value as { status: string; response: string };
    expect(task.status).toBe("completed");
    expect(task.response).toContain("✅「全站深色模式」");
    expect(task.response).toContain("✅「导出 Excel 含头像」");
    expect(task.response).toContain("全部任务处理完毕");

    // 两个任务都经 create-from-message + 自动 confirm-prompt
    const creates = calls.filter((c) => c.path === "/v1/tasks/create-from-message");
    expect(creates).toHaveLength(2);
    const confirms = calls.filter((c) => c.path.includes("/confirm-prompt"));
    expect(confirms).toHaveLength(2);
    // 每个任务 prompt 含统一设计文档(E5 规则 2)
    const body0 = creates[0]!.body as { description: string };
    expect(body0.description).toContain("【统一设计】");
    expect(body0.description).toContain("# 统一设计");
    // 拓扑序: T1(深色模式) 先于 T2(导出)
    expect((creates[0]!.body as { title: string }).title).toBe("全站深色模式");
    expect((creates[1]!.body as { title: string }).title).toBe("导出 Excel 含头像");
  }, 30_000);

  it("E9-6: 首任务失败 → 队列暂停, 后续不派发; 「确认」断点续跑", async () => {
    const ctx = mockContext('{"is_task": true}');
    const ids: string[] = [];
    for (const t of ["页面要实现深色模式", "开发用户列表导出 Excel 功能"]) {
      const r = await timemProjectTaskProvider.execute(
        { user_input: t, session_id: "buf-5", quiet_ms: 0 },
        ctx,
      );
      if (r.ok && r.value.type === "collected") ids.push(r.value.requirementId);
    }
    const cctx = mockContext('{"is_task": true}', { consolidation: consolidationJson(ids) });
    await timemProjectTaskProvider.execute({ user_input: "就这些了", session_id: "buf-5", quiet_ms: 0 }, cctx);

    // 第一轮: t1 失败 → 暂停, T2 不派发
    let t1Failed = true;
    const { calls } = mockUds2((taskId) => (taskId === "t1" && t1Failed ? "failed" : "completed"));
    overrideTimemTaskHooks({ gitInWorkTree: async () => true, gitHasOrigin: async () => true });
    const r1 = await timemProjectTaskProvider.execute(
      { user_input: "确认", session_id: "buf-5", quiet_ms: 0 },
      mockContext('{"is_task": true}'),
    );
    expect(r1.ok && r1.value.type).toBe("task");
    expect((r1.value as { status: string }).status).toBe("paused");
    expect((r1.value as { response: string }).response).toContain("❌「全站深色模式」");
    expect(calls.filter((c) => c.path === "/v1/tasks/create-from-message")).toHaveLength(1);

    // 第二轮: 修复后「确认」续跑 → 补齐 T1+T2, 全部完成
    t1Failed = false;
    const r2 = await timemProjectTaskProvider.execute(
      { user_input: "确认", session_id: "buf-5", quiet_ms: 0 },
      mockContext('{"is_task": true}'),
    );
    expect(r2.ok && r2.value.type).toBe("task");
    expect((r2.value as { status: string }).status).toBe("completed");
    // 两轮共派发 3 次(第一轮 T1 失败 + 第二轮 T1 重跑、T2)
    expect(calls.filter((c) => c.path === "/v1/tasks/create-from-message")).toHaveLength(3);
  }, 30_000);

  it("E9-5: 确认页补充需求 → 立即重汇总 version+1", async () => {
    const ctx = mockContext('{"is_task": true}');
    const ids: string[] = [];
    for (const t of ["页面要实现深色模式", "开发用户列表导出 Excel 功能"]) {
      const r = await timemProjectTaskProvider.execute(
        { user_input: t, session_id: "buf-6", quiet_ms: 0 },
        ctx,
      );
      if (r.ok && r.value.type === "collected") ids.push(r.value.requirementId);
    }
    const cctx1 = mockContext('{"is_task": true}', { consolidation: consolidationJson(ids) });
    const c1 = await timemProjectTaskProvider.execute(
      { user_input: "就这些了", session_id: "buf-6", quiet_ms: 0 },
      cctx1,
    );
    expect(c1.ok && (c1.value as { version: number }).version).toBe(1);

    // 确认页补充 → collected 后自动重汇总 v2(mock 按实际 req id 动态生成)
    const idsFromUserContent = (uc: string) =>
      uc.split("\n").map((l) => l.split(":")[0]!.trim()).filter((id) => id.startsWith("req_"));
    const cctx2 = mockContext('{"is_task": true}', {
      consolidation: (uc) => consolidationJson(idsFromUserContent(uc)),
    });
    const r = await timemProjectTaskProvider.execute(
      { user_input: "再加上手机端适配", session_id: "buf-6", quiet_ms: 0 },
      cctx2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.type).toBe("consolidation");
    expect((r.value as { version: number }).version).toBe(2);
  });

  it("E9-8: 显式单任务(项目名+单一动作)仍走快车道, 不进缓冲区", async () => {
    const { calls } = mockUds2(() => "completed");
    overrideTimemTaskHooks({ gitInWorkTree: async () => true, gitHasOrigin: async () => true });
    const r = await timemProjectTaskProvider.execute(
      { user_input: "在 demo 项目执行 echo hello", session_id: "buf-7", quiet_ms: 0 },
      mockContext('{"is_task": true}'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(["task", "confirm"]).toContain(r.value.type);
    expect(calls.some((c) => c.path === "/v1/tasks/create-from-message")).toBe(true);
  });

  it("signal=summarize(前端按钮)等价于「就这些了」; 空清单报错", async () => {
    const r = await timemProjectTaskProvider.execute(
      { user_input: "(按钮触发)", signal: "summarize", session_id: "buf-8", quiet_ms: 0 },
      mockContext('{"is_task": true}'),
    );
    expect(r.ok && r.value.type).toBe("error");
  });
});
