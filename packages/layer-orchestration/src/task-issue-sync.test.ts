/**
 * task-issue-sync 派发域单测：纯函数（分组常量/工单号解析/提示词组装/闸门时长）
 * + scan 模式路由 + 派发确认/取消意图路由（mock feishu/gitea/LLM refs）。
 */
import { describe, it, expect } from "vitest";
import {
  SECTION_NAMES,
  issueNumberFromTaskSummary,
  buildDispatchPrompt,
  dispatchDelayMs,
  taskIssueSyncProvider,
} from "./task-issue-sync.js";
import type { SeamContext } from "@aigility-harness/core";

describe("SECTION_NAMES 状态分组", () => {
  it("四状态 P/D/C/A 齐全", () => {
    expect(SECTION_NAMES.plan).toBe("P 计划中");
    expect(SECTION_NAMES.doing).toBe("D 执行中");
    expect(SECTION_NAMES.check).toBe("C 待测试");
    expect(SECTION_NAMES.fix).toBe("A 待修复");
  });
});

describe("issueNumberFromTaskSummary", () => {
  it("从 [org/repo#N] 标题解析工单号", () => {
    expect(issueNumberFromTaskSummary("[TiMEM-AI/timem-platform-backend#21] 修复登录页白屏")).toBe(21);
    expect(issueNumberFromTaskSummary("[a/b#3] x")).toBe(3);
  });
  it("非双建标题返回 undefined", () => {
    expect(issueNumberFromTaskSummary("普通任务标题")).toBeUndefined();
    expect(issueNumberFromTaskSummary("[没有编号] x")).toBeUndefined();
    expect(issueNumberFromTaskSummary(undefined)).toBeUndefined();
  });
});

describe("buildDispatchPrompt", () => {
  it("含工单号/标题/正文/提交要求", () => {
    const p = buildDispatchPrompt("org/repo", {
      number: 9,
      title: "修复白屏",
      body: "打开首页即白屏",
    });
    expect(p).toContain("org/repo 工单 #9");
    expect(p).toContain("修复白屏");
    expect(p).toContain("打开首页即白屏");
    expect(p).toContain("#9");
  });
  it("无正文也成立", () => {
    const p = buildDispatchPrompt("org/repo", { number: 1, title: "t" });
    expect(p).toContain("工单 #1");
  });
});

describe("dispatchDelayMs", () => {
  it("默认 15 分钟", () => {
    delete process.env.TIMEM_DISPATCH_CONFIRM_MS;
    expect(dispatchDelayMs()).toBe(15 * 60_000);
  });
  it("env 可覆盖", () => {
    process.env.TIMEM_DISPATCH_CONFIRM_MS = "60000";
    expect(dispatchDelayMs()).toBe(60_000);
    delete process.env.TIMEM_DISPATCH_CONFIRM_MS;
  });
});

/** 构造最小 SeamContext mock：按 ref.id 分发响应 */
function mockCtx(handler: (refId: string, req: Record<string, unknown>) => unknown): SeamContext {
  return {
    sessionId: "s1",
    call: async (ref: { id: string }, req: unknown) => handler(ref.id, req as Record<string, unknown>),
  } as unknown as SeamContext;
}

describe("scan 模式路由", () => {
  it("清单不可用时返回跳过文案", async () => {
    const ctx = mockCtx((_id, req) => {
      if (String((req as { path?: string }).path).includes("/tasklists")) {
        return { ok: true, value: { code: 0, data: { items: [] } } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    // ensureTasklist 走 findTasklistByName（空）→ create（失败模拟）
    const ctxFail = mockCtx((id, req) => {
      if (id.includes("feishu")) {
        if (String((req as { method?: string }).method) === "POST" && String((req as { path?: string }).path).includes("/tasklists")) {
          return { ok: false, error: "denied" };
        }
        return { ok: true, value: { code: 0, data: { items: [] } } };
      }
      return { ok: true, value: { status: 200, data: [] } };
    });
    const r = await taskIssueSyncProvider.execute({ mode: "scan", tasklistName: "X" }, ctxFail);
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("扫描跳过");
    void ctx;
  });
});

describe("派发确认/取消意图路由", () => {
  it("取消：无匹配任务时给出提示", async () => {
    const ctx = mockCtx((id) => {
      if (id.includes("feishu") || id.includes("gitea")) return { ok: true, value: { code: 0, status: 200, data: [] } };
      return { ok: true, value: { code: 0, data: [] } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "dispatch-cancel", ref: "42" } },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("没有找到工单 #42");
  });

  it("确认：格式错误给用法", async () => {
    const ctx = mockCtx(() => ({ ok: true, value: { code: 0, data: [] } }));
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "dispatch-confirm", ref: "abc" } },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("用法");
  });
});
