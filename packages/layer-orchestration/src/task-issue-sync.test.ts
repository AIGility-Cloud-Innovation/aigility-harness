/**
 * task-issue-sync 派发域单测：纯函数（分组常量/工单号解析/提示词组装/闸门时长）
 * + scan 模式路由 + 派发确认/取消意图路由（mock feishu/gitea/LLM refs）。
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  SECTION_NAMES,
  issueNumberFromTaskSummary,
  buildDispatchPrompt,
  dispatchDelayMs,
  taskIssueSyncProvider,
  autoDispatchEnabled,
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

// ── autoDispatchEnabled — agent 自动执行开关 ─────────────────────────

describe("autoDispatchEnabled — TASK_AUTO_DISPATCH 开关", () => {
  const saved = process.env["TASK_AUTO_DISPATCH"];
  const set = (v?: string) => {
    if (v === undefined) delete process.env["TASK_AUTO_DISPATCH"];
    else process.env["TASK_AUTO_DISPATCH"] = v;
  };

  it("未设置/其他值 → 默认开启", () => {
    set(undefined);
    expect(autoDispatchEnabled()).toBe(true);
    set("1");
    expect(autoDispatchEnabled()).toBe(true);
  });

  it("0/false/off（大小写不敏感）→ 关闭", () => {
    for (const v of ["0", "false", "off", "OFF", "False"]) {
      set(v);
      expect(autoDispatchEnabled()).toBe(false);
    }
  });

  afterAll(() => {
    if (saved === undefined) delete process.env["TASK_AUTO_DISPATCH"];
    else process.env["TASK_AUTO_DISPATCH"] = saved;
  });
});

// ── 澄清归属（任务归属/跳过任务）+ 派发仓库反解 + scan 多清单 ──────

import { resolveRepoByIssueNo } from "./task-issue-sync.js";
import {
  addPendingCandidate,
  peekPendingCandidate,
  clearPendingCandidates,
} from "./task-pipeline.js";

describe("澄清归属意图路由", () => {
  afterEach(() => clearPendingCandidates());

  it("私聊（无 session_id）拒绝认领", async () => {
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: "1", repo: "video" } },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("群里");
  });

  it("编号不存在 → 提示且不发起任何 API 调用", async () => {
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: "9", repo: "video" }, session_id: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("没有找到本群待归属任务 #9");
  });

  it("只能在识别它的群里认领：B 群认领 A 群候选 → 没有找到", async () => {
    const item = addPendingCandidate("oc_a", { title: "t", priority: "P1" }, ["org/r1"]);
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "org/r1" }, session_id: "oc_b" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("没有找到本群待归属任务");
    expect(peekPendingCandidate("oc_a", item.no)).toBeDefined();
  });

  it("仓库短名解析失败 → 保留队列项可重试", async () => {
    const item = addPendingCandidate("oc_a", { title: "t", priority: "P1" }, ["org/r1"]);
    const ctx = mockCtx((id) => {
      if (id.includes("gitea")) return { ok: true, value: { status: 200, data: { ok: true, data: [] } } };
      return { ok: true, value: { code: 0, data: [] } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "nonsense" }, session_id: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("解析失败");
    expect(peekPendingCandidate("oc_a", item.no)).toBeDefined();
  });

  it("全名仓库走通建单并消费队列（查重 → 建单 → 双建同步）", async () => {
    const item = addPendingCandidate("oc_a", { title: "修白屏", priority: "P1", reason: "线上报障" }, ["AIGility/x"]);
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("gitea")) {
        if (method === "GET" && path.endsWith("/issues")) return { ok: true, value: { status: 200, data: [] } };
        if (method === "POST" && path.endsWith("/issues")) {
          return { ok: true, value: { status: 201, data: { number: 7, html_url: "https://g/x/7" } } };
        }
      }
      if (id.includes("feishu")) {
        if (path.endsWith("/tasklists") && method === "GET") return { ok: true, value: { code: 0, data: { items: [] } } };
        if (path.endsWith("/tasklists") && method === "POST") return { ok: true, value: { code: 0, data: { tasklist: { guid: "tl1" } } } };
        if (path === "/open-apis/task/v2/tasks" && method === "POST") return { ok: true, value: { code: 0, data: { task: { guid: "tg1" } } } };
        if (path.includes("/add_tasklist")) return { ok: true, value: { code: 0, data: {} } };
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { code: 0, data: [] } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "AIGility/x" }, session_id: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("已建工单 AIGility/x #7");
    expect(r.value.response).toContain("修白屏");
    expect(r.value.response).toContain("已同步飞书任务");
    expect(peekPendingCandidate("oc_a", item.no)).toBeUndefined();
  });

  it("跳过任务 N：跨群不误删，本群丢弃", async () => {
    const item = addPendingCandidate("oc_a", { title: "t", priority: "P1" }, ["org/r1"]);
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r1 = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-skip", ref: String(item.no) }, session_id: "oc_b" },
      ctx,
    );
    if (!r1.ok) throw new Error("execute failed");
    expect(r1.value.response).toContain("没有找到");
    const r2 = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-skip", ref: String(item.no) }, session_id: "oc_a" },
      ctx,
    );
    if (!r2.ok) throw new Error("execute failed");
    expect(r2.value.response).toContain("已丢弃");
    expect(peekPendingCandidate("oc_a", item.no)).toBeUndefined();
  });
});

describe("resolveRepoByIssueNo — 派发仓库反解", () => {
  it("从双建任务标题 [org/repo#N] 反查；查不到 undefined", async () => {
    const ctx = mockCtx((id) => {
      if (id.includes("feishu")) {
        return {
          ok: true,
          value: { code: 0, data: { items: [{ summary: "[AIGility/x#7] 修白屏" }, { summary: "普通任务" }] } },
        };
      }
      return { ok: true, value: { code: 0, data: [] } };
    });
    expect(await resolveRepoByIssueNo(ctx, 7)).toBe("AIGility/x");
    expect(await resolveRepoByIssueNo(ctx, 99)).toBeUndefined();
  });
});

describe("scan 多清单路由", () => {
  it("tasklistNames 逐清单跑闸门（每个清单各建一次分组）", async () => {
    let sectionsGet = 0;
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (!id.includes("feishu")) return { ok: true, value: { status: 200, data: [] } };
      if (path.endsWith("/tasklists") && method === "GET") {
        return {
          ok: true,
          value: { code: 0, data: { items: [{ guid: "g-a", name: "A-Org" }, { guid: "g-t", name: "TiMEM-AI" }] } },
        };
      }
      if (path.endsWith("/sections") && method === "GET") {
        sectionsGet++;
        return { ok: true, value: { code: 0, data: { items: [] } } };
      }
      if (path.endsWith("/sections") && method === "POST") {
        return { ok: true, value: { code: 0, data: { section: { guid: `s-${sectionsGet}` } } } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistNames: ["A-Org", "TiMEM-AI"] },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toBe("（本轮无待处理任务）");
    expect(sectionsGet).toBe(2);
  });
});
