import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractRepoSpec,
  parseTaskIntent,
  feishuTaskAssistantProvider,
  llmInferenceRefForPersona,
} from "./feishu-task-assistant.js";

describe("parseTaskIntent — 飞书任务意图", () => {
  it("建任务：<标题>", () => {
    expect(parseTaskIntent("建任务：周五交周报")).toEqual({
      kind: "task-need-repo",
      title: "周五交周报",
    });
  });

  it("建任务带截止日期", () => {
    expect(parseTaskIntent("创建任务 写周报 截止 2026-10-16")).toEqual({
      kind: "task-need-repo",
      title: "写周报",
      dueDate: "2026-10-16",
    });
  });

  it("建任务 @仓库 → 双建意图（C 方案）", () => {
    expect(parseTaskIntent("建任务 @video：修复登录页白屏")).toEqual({
      kind: "create",
      title: "修复登录页白屏",
      repo: "video",
    });
  });

  it("建任务 @仓库 + 截止日期 → 双建意图带截止", () => {
    expect(parseTaskIntent("建任务 @TiMEM-AI/x：写周报 截止 2026-10-16")).toEqual({
      kind: "create",
      title: "写周报",
      dueDate: "2026-10-16",
      repo: "TiMEM-AI/x",
    });
  });

  it("标题为空的建任务不算创建意图", () => {
    expect(parseTaskIntent("建任务：")).toEqual({ kind: "help" });
  });

  it("查询意图（多个触发词）", () => {
    for (const text of ["我的任务", "任务列表", "列出任务", "查任务", "看看任务"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "list" });
    }
  });

  it("完成 <关键字>", () => {
    expect(parseTaskIntent("完成 周报")).toEqual({ kind: "complete", keyword: "周报" });
    expect(parseTaskIntent("完成了 周报")).toEqual({ kind: "complete", keyword: "周报" });
  });

  it("其他输入 → 帮助", () => {
    expect(parseTaskIntent("你好")).toEqual({ kind: "help" });
  });
});

describe("parseTaskIntent — Gitea 工单意图", () => {
  it("建工单 @组织/仓库：<标题>（单行，显式全名）", () => {
    expect(
      parseTaskIntent("建工单 @TiMEM-AI/timem-platform-backend：修复登录页白屏"),
    ).toEqual({
      kind: "issue-create",
      repo: "TiMEM-AI/timem-platform-backend",
      title: "修复登录页白屏",
    });
  });

  it("建工单 @短名：<标题> —— 短名原样保留，full_name 解析在执行层", () => {
    expect(parseTaskIntent("建工单 @video：修复登录页白屏")).toEqual({
      kind: "issue-create",
      repo: "video",
      title: "修复登录页白屏",
    });
  });

  it("建工单缺仓库 → issue-need-repo（反问分支，不静默落默认仓库）", () => {
    expect(parseTaskIntent("建工单：修复登录页白屏")).toEqual({
      kind: "issue-need-repo",
      title: "修复登录页白屏",
    });
  });

  it("建工单多行 @仓库：首行标题其余为正文", () => {
    const intent = parseTaskIntent(
      "建工单 @video：修复登录页白屏\n复现步骤：打开首页\n期望：不白屏",
    );
    expect(intent).toEqual({
      kind: "issue-create",
      repo: "video",
      title: "修复登录页白屏",
      body: "复现步骤：打开首页\n期望：不白屏",
    });
  });

  it("标题为空的建工单不算创建意图", () => {
    expect(parseTaskIntent("建工单：")).toEqual({ kind: "help" });
  });

  it("extractRepoSpec：邮箱误触防护", () => {
    expect(parseTaskIntent("建工单：bob@example.com 收到投诉").kind).toBe("issue-need-repo");
  });

  it("工单列表（多个触发词）", () => {
    for (const text of ["工单列表", "我的工单", "列出工单"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "issue-list" });
    }
  });

  it("查工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("查工单 #12")).toEqual({
      kind: "issue-show",
      ref: "#12",
    });
    expect(parseTaskIntent("查工单 登录页")).toEqual({
      kind: "issue-show",
      ref: "登录页",
    });
  });

  it("关闭工单 <#编号或关键字>（多个触发词）", () => {
    for (const text of ["关闭工单 #3", "完成工单 #3", "关单 #3"]) {
      expect(parseTaskIntent(text)).toEqual({
        kind: "issue-close",
        ref: "#3",
      });
    }
  });

  it("重开工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("重开工单 #3")).toEqual({
      kind: "issue-reopen",
      ref: "#3",
    });
  });

  it("评论工单 <#编号> <内容>", () => {
    expect(parseTaskIntent("评论工单 #12 已修复，待发布")).toEqual({
      kind: "issue-comment",
      ref: "12",
      comment: "已修复，待发布",
    });
  });

  it("「完成工单 x」优先于任务意图「完成 x」，不被吞掉", () => {
    expect(parseTaskIntent("完成工单 白屏").kind).toBe("issue-close");
  });

  it("「建任务：修工单流程」仍是飞书任务意图（工单触发词优先但需命中）", () => {
    expect(parseTaskIntent("建任务：修工单流程")).toEqual({
      kind: "task-need-repo",
      title: "修工单流程",
    });
  });

  it("项目概览", () => {
    for (const text of ["项目概览", "项目状态", "整体概览", "概览"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "overview" });
    }
  });
});

describe("extractRepoSpec", () => {
  it("全名与短名均提取，并从文本剥离", () => {
    expect(extractRepoSpec("建工单 @TiMEM-AI/x：标题")).toEqual({
      text: "建工单 ：标题",
      repo: "TiMEM-AI/x",
    });
    expect(extractRepoSpec("建工单@video：标题")).toEqual({
      text: "建工单 ：标题",
      repo: "video",
    });
  });

  it("无仓库片段返回原文", () => {
    expect(extractRepoSpec("建工单：标题")).toEqual({ text: "建工单：标题" });
  });
});

// ── LLM 兜底回复（正则未命中） ─────────────────────────────────────

/** mock SeamContext：记录 ctx.call 并按服务 id 分发 */
function mockCtx(handlers: Record<string, (req: unknown) => unknown>) {
  const calls: { id: string; req: unknown }[] = [];
  return {
    calls,
    sessionId: "sess-test",
    traceId: "trace-test",
    async call(ref: { id: string }, req: unknown) {
      calls.push({ id: ref.id, req });
      const h = handlers[ref.id];
      return h ? h(req) : { ok: false as const, error: "no handler" };
    },
  } as never;
}

describe("feishuTaskAssistantProvider — LLM 兜底", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("正则未命中 → 调 @cognitive/llm-inference 生成自然回复", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({
        ok: true,
        value: { text: "你好！我是项目小助理，可以帮你管理任务和工单～" },
      }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "你好呀" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.response).toContain("项目小助理");
      expect(r.value.response).not.toContain("📋");
    }
  });

  it("LLM 失败 → 回退静态帮助文本（不比改动前差）", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: false, error: "网关不可用" }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "随便说点什么" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.response).toContain("项目小助理");
      expect(r.value.response).toContain("建任务 @仓库");
    }
  });

  it("TASK_ASSISTANT_LLM_FALLBACK=0 → 直接回帮助文本，不调 LLM", async () => {
    vi.stubEnv("TASK_ASSISTANT_LLM_FALLBACK", "0");
    const ctx = mockCtx({});
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "你好呀" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(ctx.calls.length).toBe(0);
    if (r.ok) {
      expect(r.value.response).toContain("建任务 @仓库");
    }
  });

  it("兜底请求形状：模型/消息/max_tokens/userId 完整", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({
        ok: true,
        value: { text: "好" },
      }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "嗨" }, ctx);
    expect(ctx.calls.length).toBe(1);
    const { id, req } = (ctx.calls as unknown[])[0] as {
      id: string;
      req: Record<string, unknown>;
    };
    expect(id).toBe(llmInferenceRefForPersona.id);
    expect(req["model"]).toBeTypeOf("string");
    expect(req["max_tokens"]).toBe(500);
    expect(req["userId"]).toBe("feishu-task-assistant-fallback");
    const messages = req["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("项目小助理");
    expect(messages[1]).toEqual({ role: "user", content: "嗨" });
  });

  it("指令意图不受影响：仍走编排层，零 LLM 调用", async () => {
    const ctx = mockCtx({
      "@orchestration/task-issue-sync": () => ({
        ok: true,
        value: { response: "已建任务" },
      }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "我的任务" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(ctx.calls.length).toBe(1);
    expect((ctx.calls as unknown[])[0]).toMatchObject({
      id: "@orchestration/task-issue-sync",
    });
    if (r.ok) expect(r.value.response).toBe("已建任务");
  });
});
