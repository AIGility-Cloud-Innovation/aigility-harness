import { describe, it, expect } from "vitest";
import {
  feishuTaskAssistantProvider,
  parseTaskIntent,
  formatTaskLine,
  formatTaskList,
  formatIssueLine,
  formatIssueList,
  formatIssueDetail,
  matchIssueByRef,
} from "./feishu-task-assistant.js";

describe("parseTaskIntent", () => {
  it("建任务：<标题>", () => {
    expect(parseTaskIntent("建任务：周五交周报")).toEqual({
      kind: "create",
      title: "周五交周报",
      dueDate: undefined,
    });
  });

  it("建任务带截止日期", () => {
    expect(parseTaskIntent("创建任务 写周报 截止 2026-10-16")).toEqual({
      kind: "create",
      title: "写周报",
      dueDate: "2026-10-16",
    });
  });

  it("标题为空的建任务不算创建意图", () => {
    expect(parseTaskIntent("建任务：")).toEqual({ kind: "help" });
  });

  it("查询意图（多个触发词）", () => {
    for (const text of ["我的任务", "任务列表", "列出任务", "看看任务"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "list" });
    }
  });

  it("完成 <关键字>", () => {
    expect(parseTaskIntent("完成 写周报")).toEqual({
      kind: "complete",
      keyword: "写周报",
    });
  });

  it("其他输入 → 帮助", () => {
    expect(parseTaskIntent("你好")).toEqual({ kind: "help" });
  });
});

describe("parseTaskIntent — Gitea 工单意图", () => {
  it("建工单：<标题>（单行）", () => {
    expect(parseTaskIntent("建工单：修复登录页白屏")).toEqual({
      kind: "issue-create",
      title: "修复登录页白屏",
      body: undefined,
    });
  });

  it("建工单多行：首行标题其余为正文", () => {
    expect(parseTaskIntent("建工单：修复登录页白屏\n复现步骤：打开首页即白屏\n环境：prod")).toEqual({
      kind: "issue-create",
      title: "修复登录页白屏",
      body: "复现步骤：打开首页即白屏\n环境：prod",
    });
  });

  it("标题为空的建工单不算创建意图", () => {
    expect(parseTaskIntent("建工单：")).toEqual({ kind: "help" });
  });

  it("工单列表（多个触发词）", () => {
    for (const text of ["工单列表", "我的工单", "列出工单", "看看工单", "查工单列表"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "issue-list" });
    }
  });

  it("查工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("查工单 #12")).toEqual({ kind: "issue-show", ref: "#12" });
    expect(parseTaskIntent("查工单：登录页")).toEqual({ kind: "issue-show", ref: "登录页" });
  });

  it("关闭工单 <#编号或关键字>（多个触发词）", () => {
    expect(parseTaskIntent("关闭工单 #3")).toEqual({ kind: "issue-close", ref: "#3" });
    expect(parseTaskIntent("完成工单 修复登录页")).toEqual({
      kind: "issue-close",
      ref: "修复登录页",
    });
    expect(parseTaskIntent("完结工单：白屏")).toEqual({ kind: "issue-close", ref: "白屏" });
  });

  it("重开工单 <#编号或关键字>", () => {
    expect(parseTaskIntent("重开工单 12")).toEqual({ kind: "issue-reopen", ref: "12" });
    expect(parseTaskIntent("重新打开工单 #12")).toEqual({ kind: "issue-reopen", ref: "#12" });
  });

  it("评论工单 <#编号> <内容>", () => {
    expect(parseTaskIntent("评论工单 #12 已定位，今天修复")).toEqual({
      kind: "issue-comment",
      ref: "12",
      comment: "已定位，今天修复",
    });
    expect(parseTaskIntent("回复工单 12：多行\n内容")).toEqual({
      kind: "issue-comment",
      ref: "12",
      comment: "多行\n内容",
    });
  });

  it("「完成工单 x」优先于任务意图「完成 x」，不被吞掉", () => {
    const intent = parseTaskIntent("完成工单 白屏");
    expect(intent.kind).toBe("issue-close");
  });

  it("「建任务：修工单流程」仍是飞书任务意图", () => {
    expect(parseTaskIntent("建任务：修工单流程")).toEqual({
      kind: "create",
      title: "修工单流程",
      dueDate: undefined,
    });
  });

  it("项目概览", () => {
    for (const text of ["项目概览", "项目状态", "整体概览", "概览"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "overview" });
    }
  });
});

describe("formatIssueLine / formatIssueList / formatIssueDetail", () => {
  it("单行带序号、状态与标签", () => {
    expect(
      formatIssueLine(
        { number: 12, title: "修复登录页白屏", state: "open", labels: [{ name: "P0" }, { name: "sdk" }] },
        2,
      ),
    ).toBe("2. 🟢 进行中 #12 修复登录页白屏（P0·sdk）");
  });

  it("已关闭状态", () => {
    expect(formatIssueLine({ number: 3, title: "X", state: "closed" })).toBe("✅ 已关闭 #3 X");
  });

  it("空列表提示创建", () => {
    expect(formatIssueList([])).toContain("建工单");
  });

  it("列表带序号", () => {
    const out = formatIssueList([
      { number: 12, title: "A", state: "open" },
      { number: 13, title: "B", state: "closed" },
    ]);
    expect(out).toContain("共 2 条工单");
    expect(out).toContain("1. 🟢 进行中 #12 A");
    expect(out).toContain("2. ✅ 已关闭 #13 B");
  });

  it("详情含状态、标签与链接", () => {
    const out = formatIssueDetail({
      number: 12,
      title: "修复登录页白屏",
      state: "open",
      html_url: "https://git.aigility.cloud/TiMEM-AI/x/issues/12",
      labels: [{ name: "P0" }],
    });
    expect(out).toContain("#12 修复登录页白屏");
    expect(out).toContain("🟢 进行中");
    expect(out).toContain("标签：P0");
    expect(out).toContain("https://git.aigility.cloud/TiMEM-AI/x/issues/12");
  });
});

describe("matchIssueByRef", () => {
  const issues = [
    { number: 12, title: "修复登录页白屏", state: "open" },
    { number: 13, title: "白屏复现跟进", state: "closed" },
    { number: 14, title: "升级依赖", state: "open" },
  ];

  it("#编号 / 纯数字精确匹配", () => {
    expect(matchIssueByRef(issues, "#12")?.number).toBe(12);
    expect(matchIssueByRef(issues, "14")?.number).toBe(14);
  });

  it("标题关键字包含匹配（大小写不敏感）", () => {
    expect(matchIssueByRef(issues, "登录页")?.number).toBe(12);
    expect(matchIssueByRef(issues, "升级依赖")?.number).toBe(14);
  });

  it("无匹配返回 undefined", () => {
    expect(matchIssueByRef(issues, "不存在")).toBeUndefined();
    expect(matchIssueByRef(issues, "#999")).toBeUndefined();
  });
});

describe("formatTaskList / formatTaskLine", () => {
  it("空列表提示创建", () => {
    expect(formatTaskList([])).toContain("建任务");
  });

  it("列表带序号与状态", () => {
    const out = formatTaskList([
      { summary: "任务A", status: "todo" },
      { summary: "任务B", status: "done" },
    ]);
    expect(out).toContain("共 2 条任务");
    expect(out).toContain("1. ☐ 待办 任务A");
    expect(out).toContain("2. ✅ 已完成 任务B");
  });

  it("单行带截止日期", () => {
    expect(formatTaskLine({ summary: "X", status: "todo", due: { date: "2026-10-16" } }, 3)).toBe(
      "3. ☐ 待办 X（截止 2026-10-16）",
    );
  });
});

describe("provider execute — 工单流程（stub ctx.call）", () => {
  /** 按 action 服务 id 路由的假 ctx，记录全部调用便于断言 */
  function makeFakeCtx(
    handlers: Record<string, (req: Record<string, unknown>) => unknown>,
  ) {
    const calls: { id: string; req: Record<string, unknown> }[] = [];
    const ctx = {
      traceId: "test-trace",
      sessionId: "test-session",
      emit: () => {},
      call: async (ref: { id: string }, req: Record<string, unknown>) => {
        calls.push({ id: ref.id, req });
        return handlers[ref.id](req);
      },
    };
    return { ctx: ctx as never, calls };
  }

  it("关闭工单：编号直取详情 → PATCH → 以响应体 state 做写后验证", async () => {
    const { ctx } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if (req.method === "GET") {
          return {
            ok: true,
            value: {
              status: 200,
              data: { number: 61, title: "BM25 租户 filter", state: "open" },
            },
          };
        }
        return {
          ok: true,
          value: {
            status: 201, // 本实例 PATCH 怪癖：返回 201
            data: { number: 61, title: "BM25 租户 filter", state: "closed" },
          },
        };
      },
    });
    const r = await feishuTaskAssistantProvider.execute({ user_input: "关闭工单 #61" }, ctx);
    expect(r.ok).toBe(true);
    expect((r as { value: { response: string } }).value.response).toContain("已关闭工单 #61");
  });

  it("建工单：命中同名工单时查重拦截，不发起 POST", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if (req.method === "GET") {
          return {
            ok: true,
            value: {
              status: 200,
              data: [{ number: 7, title: "修复登录页白屏", state: "open" }],
            },
          };
        }
        return { ok: true, value: { status: 201, data: { number: 8 } } };
      },
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "建工单：修复登录页白屏" },
      ctx,
    );
    expect(r.ok).toBe(true);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已有同名工单");
    expect(response).toContain("#7");
    expect(calls.filter((c) => c.req.method === "POST")).toHaveLength(0);
  });

  it("建工单：无同名时 POST 创建并回链", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if (req.method === "GET") {
          return { ok: true, value: { status: 200, data: [] } };
        }
        return {
          ok: true,
          value: {
            status: 201,
            data: {
              number: 8,
              title: "修复登录页白屏",
              state: "open",
              html_url: "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/issues/8",
            },
          },
        };
      },
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "建工单：修复登录页白屏" },
      ctx,
    );
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已建工单 #8");
    expect(response).toContain("issues/8");
    const post = calls.find((c) => c.req.method === "POST");
    expect(post).toBeDefined();
    expect((post!.req.path as string).endsWith("/issues")).toBe(true);
  });

  it("项目概览：飞书与 Gitea 单侧失败不影响另一侧", async () => {
    const { ctx } = makeFakeCtx({
      "@action/feishu-api": () => ({ ok: false, error: "OAuth 过期" }),
      "@action/gitea-api": () => ({
        ok: true,
        value: { status: 200, data: [{ number: 61, title: "BM25 租户 filter", state: "open" }] },
      }),
    });
    const r = await feishuTaskAssistantProvider.execute({ user_input: "项目概览" }, ctx);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("项目概览");
    expect(response).toContain("查询失败"); // 飞书侧降级
    expect(response).toContain("#61"); // Gitea 侧正常
  });
});
