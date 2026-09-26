import { describe, it, expect } from "vitest";
import {
  taskIssueSyncProvider,
  formatIssueLine,
  formatIssueList,
  formatIssueDetail,
  formatTaskLine,
  formatTaskList,
  matchIssueByRef,
  syncTaskSummary,
  tasklistNameForRepo,
} from "./task-issue-sync.js";
import type { TaskIntent } from "./task-issue-sync.js";

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

describe("双建同步纯函数", () => {
  it("syncTaskSummary：[org/repo#N] 标题", () => {
    expect(syncTaskSummary("TiMEM-AI/x", { number: 8, title: "修复白屏" })).toBe(
      "[TiMEM-AI/x#8] 修复白屏",
    );
    expect(syncTaskSummary("TiMEM-AI/x", { title: "无编号" })).toBe("[TiMEM-AI/x#?] 无编号");
  });

  it("tasklistNameForRepo：org 对应清单", () => {
    expect(tasklistNameForRepo("TiMEM-AI/timem-platform-backend")).toBe("TiMEM-AI");
    expect(tasklistNameForRepo("no-slash")).toBe("no-slash");
  });
});

describe("provider execute — 业务域流程（stub ctx.call）", () => {
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

  const intent = (i: TaskIntent) => ({ mode: "intent" as const, intent: i });

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
    const r = await taskIssueSyncProvider.execute(intent({ kind: "issue-close", ref: "#61" }), ctx);
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
    const r = await taskIssueSyncProvider.execute(
      intent({
        kind: "issue-create",
        repo: "TiMEM-AI/timem-platform-backend",
        title: "修复登录页白屏",
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已有同名工单");
    expect(response).toContain("#7");
    expect(calls.filter((c) => c.req.method === "POST")).toHaveLength(0);
  });

  it("建工单缺仓库解析：反问并列出可访问仓库，不发查重/POST", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": () => ({
        ok: true,
        value: {
          status: 200,
          data: [
            { full_name: "AIGility-Cloud-Innovation/nx-telecom-video-platform" },
            { full_name: "TiMEM-AI/timem-platform-backend" },
          ],
        },
      }),
    });
    const r = await taskIssueSyncProvider.execute(intent({ kind: "issue-need-repo", title: "修复登录页白屏" }), ctx);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("请指定仓库");
    expect(response).toContain("@组织/仓库：修复登录页白屏");
    expect(response).toContain("nx-telecom-video-platform");
    // 只允许一次 repos/search 读请求，零写请求、零查重
    expect(calls).toHaveLength(1);
    expect(calls[0].req.path).toBe("/api/v1/repos/search");
    expect(calls[0].req.method).toBe("GET");
  });

  it("建工单 @短名：唯一命中后按 full_name 创建 + 双建同步飞书任务挂 org 清单", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if ((req.path as string) === "/api/v1/repos/search") {
          return {
            ok: true,
            value: {
              status: 200,
              data: [
                { full_name: "AIGility-Cloud-Innovation/nx-telecom-video-platform" },
                { full_name: "TiMEM-AI/timem-platform-backend" },
              ],
            },
          };
        }
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
              html_url:
                "https://git.aigility.cloud/AIGility-Cloud-Innovation/nx-telecom-video-platform/issues/8",
            },
          },
        };
      },
      "@action/feishu-api": (req) => {
        if ((req.path as string) === "/open-apis/task/v2/tasklists") {
          return {
            ok: true,
            value: {
              code: 0,
              data: { items: [{ guid: "list-1", name: "AIGility-Cloud-Innovation" }] },
            },
          };
        }
        if ((req.path as string) === "/open-apis/task/v2/tasks" && req.method === "POST") {
          return {
            ok: true,
            value: { code: 0, data: { task: { guid: "task-9", summary: req.summary } } },
          };
        }
        if ((req.path as string)?.includes("/add_tasklist")) {
          return { ok: true, value: { code: 0, data: {} } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      },
    });
    const r = await taskIssueSyncProvider.execute(
      intent({
        kind: "issue-create",
        repo: "video", // 短名
        title: "修复登录页白屏",
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已建工单");
    expect(response).toContain("AIGility-Cloud-Innovation/nx-telecom-video-platform #8");
    expect(response).toContain("已同步飞书任务"); // 双建同步成功
    // 工单 POST 一次
    const issuePost = calls.find(
      (c) => c.id === "@action/gitea-api" && c.req.method === "POST",
    );
    expect(issuePost).toBeDefined();
    expect(issuePost!.req.path).toBe(
      "/api/v1/repos/AIGility-Cloud-Innovation/nx-telecom-video-platform/issues",
    );
    // 飞书任务建一次 + 挂清单一次（挂清单用任务维度 add_tasklist 端点）
    const taskPost = calls.find(
      (c) => c.req.path === "/open-apis/task/v2/tasks" && c.req.method === "POST",
    );
    expect(taskPost).toBeDefined();
    expect((taskPost!.req.body as { summary?: string }).summary).toBe(
      "[AIGility-Cloud-Innovation/nx-telecom-video-platform#8] 修复登录页白屏",
    );
    const addList = calls.find((c) => (c.req.path as string)?.includes("/add_tasklist"));
    expect(addList).toBeDefined();
    expect(addList!.req.path).toBe("/open-apis/task/v2/tasks/task-9/add_tasklist");
    expect((addList!.req.body as { tasklist_guid?: string }).tasklist_guid).toBe("list-1");
  });

  it("建工单成功但飞书同步失败：部分成功回执（⚠️ 注明，不回滚）", async () => {
    const { ctx } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if (req.method === "GET") return { ok: true, value: { status: 200, data: [] } };
        return {
          ok: true,
          value: {
            status: 201,
            data: { number: 9, title: "T", state: "open", html_url: "https://x/issues/9" },
          },
        };
      },
      "@action/feishu-api": () => ({ ok: false, error: "OAuth 过期" }),
    });
    const r = await taskIssueSyncProvider.execute(
      intent({ kind: "issue-create", repo: "TiMEM-AI/x", title: "T" }),
      ctx,
    );
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已建工单 TiMEM-AI/x #9");
    expect(response).toContain("⚠️");
    expect(response).toContain("飞书同步未完成");
  });

  it("sync-issue 原语模式：task-pipeline 自动建单后的单向同步", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/feishu-api": (req) => {
        if ((req.path as string) === "/open-apis/task/v2/tasklists") {
          return {
            ok: true,
            value: { code: 0, data: { items: [{ guid: "tl-1", name: "TiMEM-AI" }] } },
          };
        }
        if (req.method === "POST" && (req.path as string) === "/open-apis/task/v2/tasks") {
          return { ok: true, value: { code: 0, data: { task: { guid: "tk-1" } } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      },
    });
    const r = await taskIssueSyncProvider.execute(
      {
        mode: "sync-issue",
        repo: "TiMEM-AI/timem-platform-backend",
        issue: { number: 12, title: "自动建单", html_url: "https://x/issues/12" },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已同步飞书任务");
    expect(response).toContain("TiMEM-AI");
    const taskPost = calls.find(
      (c) => c.req.path === "/open-apis/task/v2/tasks" && c.req.method === "POST",
    );
    expect((taskPost!.req.body as { summary?: string }).summary).toBe(
      "[TiMEM-AI/timem-platform-backend#12] 自动建单",
    );
  });

  it("建任务缺仓库（task-need-repo）：反问，零写请求", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": () => ({
        ok: true,
        value: {
          status: 200,
          data: [{ full_name: "TiMEM-AI/timem-platform-backend" }],
        },
      }),
    });
    const r = await taskIssueSyncProvider.execute(
      intent({ kind: "task-need-repo", title: "写周报" }),
      ctx,
    );
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("请指定仓库");
    expect(response).toContain("建任务 @组织/仓库：写周报");
    expect(calls.filter((c) => c.req.method === "POST")).toHaveLength(0);
  });

  it("建任务 @仓库：飞书任务 + Gitea 工单双建", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if ((req.path as string) === "/api/v1/repos/search") {
          return {
            ok: true,
            value: { status: 200, data: [{ full_name: "TiMEM-AI/timem-platform-backend" }] },
          };
        }
        if (req.method === "GET") return { ok: true, value: { status: 200, data: [] } };
        return {
          ok: true,
          value: {
            status: 201,
            data: {
              number: 21,
              title: "写周报",
              state: "open",
              html_url: "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/issues/21",
            },
          },
        };
      },
      "@action/feishu-api": (req) => {
        if ((req.path as string) === "/open-apis/task/v2/tasklists") {
          return {
            ok: true,
            value: { code: 0, data: { items: [{ guid: "tl-2", name: "TiMEM-AI" }] } },
          };
        }
        if (req.method === "POST" && (req.path as string) === "/open-apis/task/v2/tasks") {
          return {
            ok: true,
            value: { code: 0, data: { task: { guid: "tk-2", summary: "写周报" } } },
          };
        }
        return { ok: true, value: { code: 0, data: {} } };
      },
    });
    const r = await taskIssueSyncProvider.execute(
      intent({
        kind: "create",
        title: "写周报",
        dueDate: "2026-10-16",
        repo: "TiMEM-AI/timem-platform-backend",
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已创建任务：写周报（截止 2026-10-16）");
    expect(response).toContain("已同步建工单 TiMEM-AI/timem-platform-backend #21");
    expect(response).toContain("已同步飞书任务"); // 工单建后顺手挂清单
    // 工单 POST 带截止日期来源说明
    const issuePost = calls.find(
      (c) => c.id === "@action/gitea-api" && c.req.method === "POST",
    );
    expect((issuePost!.req.body as { body?: string }).body).toContain("2026-10-16");
  });

  it("建任务：同名工单已存在 → 只建任务不重复建单", async () => {
    const { ctx, calls } = makeFakeCtx({
      "@action/gitea-api": (req) => {
        if ((req.path as string) === "/api/v1/repos/search") {
          return {
            ok: true,
            value: { status: 200, data: [{ full_name: "TiMEM-AI/timem-platform-backend" }] },
          };
        }
        if (req.method === "GET") {
          return {
            ok: true,
            value: { status: 200, data: [{ number: 7, title: "写周报", state: "open" }] },
          };
        }
        return { ok: true, value: { status: 201, data: { number: 99 } } };
      },
      "@action/feishu-api": () => ({
        ok: true,
        value: { code: 0, data: { task: { guid: "tk-3", summary: "写周报" } } },
      }),
    });
    const r = await taskIssueSyncProvider.execute(
      intent({
        kind: "create",
        title: "写周报",
        repo: "TiMEM-AI/timem-platform-backend",
      }),
      ctx,
    );
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("已创建任务");
    expect(response).toContain("已有同名工单");
    expect(response).toContain("#7");
    // 无 gitea POST（不重复建单）
    expect(
      calls.filter((c) => c.id === "@action/gitea-api" && c.req.method === "POST"),
    ).toHaveLength(0);
  });

  it("项目概览：飞书与 Gitea 单侧失败不影响另一侧", async () => {
    const { ctx } = makeFakeCtx({
      "@action/feishu-api": () => ({ ok: false, error: "OAuth 过期" }),
      "@action/gitea-api": () => ({
        ok: true,
        value: { status: 200, data: [{ number: 61, title: "BM25 租户 filter", state: "open" }] },
      }),
    });
    const r = await taskIssueSyncProvider.execute(intent({ kind: "overview" }), ctx);
    const response = (r as { value: { response: string } }).value.response;
    expect(response).toContain("项目概览");
    expect(response).toContain("查询失败"); // 飞书侧降级
    expect(response).toContain("#61"); // Gitea 侧正常
  });
});
