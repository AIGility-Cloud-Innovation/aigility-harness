/**
 * task-issue-sync 派发域单测：纯函数（分组常量/工单号解析/提示词组装/闸门时长）
 * + scan 模式路由 + 派发确认/取消意图路由（mock feishu/gitea/LLM refs）。
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  SECTION_NAMES,
  issueNumberFromTaskSummary,
  assigneeFromTask,
  executorOfTask,
  stripPendingExecutorTag,
  normalizeGateTags,
  stripExecutorTagNormalized,
  stripRepoTagNormalized,
  GATE_TAG_REPO,
  buildDispatchPrompt,
  dispatchDelayMs,
  taskIssueSyncProvider,
  autoDispatchEnabled,
  runPlanGate,
} from "./task-issue-sync.js";
import { TaskRegistry } from "./task-registry.js";
import { FEISHU_TASK_PROVIDER_ID } from "./feishu-task-provider.js";
import { TASK_STATUS_TRANSITIONS } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";

describe("SECTION_NAMES 状态分组", () => {
  it("四状态 P/D/C/A 齐全", () => {
    expect(SECTION_NAMES.plan).toBe("P 计划中");
    expect(SECTION_NAMES.doing).toBe("D 执行中");
    expect(SECTION_NAMES.check).toBe("C 待测试");
    expect(SECTION_NAMES.fix).toBe("A 待修复");
  });
});

describe("normalizeGateTags / stripExecutorTagNormalized（2026-10-23 连环叠标缺陷修复）", () => {
  it("×7 新旧名交替叠链收敛为单标签（现网事故形态）", () => {
    const bad = "【待确认归属】【待确认仓库】【待确认归属】【待确认仓库】【待确认归属】【待确认仓库】优化简历评估系统";
    expect(normalizeGateTags(bad)).toBe("【待确认仓库】优化简历评估系统");
  });
  it("打标幂等：已带标签原样返回", () => {
    const s = "【待确认仓库】优化简历评估系统";
    expect(normalizeGateTags(`【${GATE_TAG_REPO}】${s}`)).toBe(s);
  });
  it("两标签互斥：同时出现时只保留【待安排执行者】（执行人闸门在前）", () => {
    expect(normalizeGateTags("【待安排执行者】【待确认归属】对接宇乐数")).toBe("【待安排执行者】对接宇乐数");
    expect(normalizeGateTags("【待确认仓库】【待安排执行者】对接宇乐数")).toBe("【待安排执行者】对接宇乐数");
  });
  it("正文里的同名文本不动", () => {
    const s = "讨论【待确认归属】规则的会议";
    expect(normalizeGateTags(s)).toBe(s);
  });
  it("业务标签保留：闸门标签摘除/收敛时不动【重要】等其余前缀", () => {
    expect(normalizeGateTags("【重要】【待确认仓库】修 bug")).toBe("【待确认仓库】【重要】修 bug");
    expect(normalizeGateTags("【重要】修 bug")).toBe("【重要】修 bug");
  });
  it("摘牌：执行人已定 → 执行者标签摘除、仓库标签保留转新名", () => {
    expect(stripExecutorTagNormalized("【待确认归属】【待安排执行者】催办海鑫网站开发进度")).toBe(
      "【待确认仓库】催办海鑫网站开发进度",
    );
  });
  it("摘牌：无仓库标签 → 纯正文", () => {
    expect(stripExecutorTagNormalized("【待安排执行者】修 bug")).toBe("修 bug");
  });
  it("真人负责人摘仓库牌：仓库标签（含旧名）摘除、执行者标签归一化保留", () => {
    expect(stripRepoTagNormalized("【待确认仓库】修 bug")).toBe("修 bug");
    expect(stripRepoTagNormalized("【待确认归属】【待安排执行者】修 bug")).toBe("【待安排执行者】修 bug");
  });
});

describe("stripPendingExecutorTag（保留兼容，逻辑已被 normalizeGateTags 覆盖）", () => {
  it("链首摘除", () => {
    expect(stripPendingExecutorTag("【待安排执行者】修 bug")).toBe("修 bug");
  });
  it("链中摘除（待确认仓库之后，今天 13 张卡的实际形态）", () => {
    expect(stripPendingExecutorTag("【待确认仓库】【待安排执行者】对接宇乐数确认 Open 付费方式")).toBe(
      "【待确认仓库】对接宇乐数确认 Open 付费方式",
    );
  });
  it("非前缀链内不动（正文引用不算标签）", () => {
    const s = "讨论【待安排执行者】规则的会议纪要";
    expect(stripPendingExecutorTag(s)).toBe(s);
  });
  it("无标签原样返回", () => {
    expect(stripPendingExecutorTag("普通任务标题")).toBe("普通任务标题");
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

describe("assigneeFromTask/executorOfTask（执行人=负责人，2026-10-10 铁律）", () => {
  it("负责人（members assignee）解析出执行人", () => {
    expect(
      assigneeFromTask({ members: [{ id: "ou_x", role: "assignee", type: "user" }, { id: "ou_y", role: "follower" }] }),
    ).toBeTypeOf("string");
    expect(assigneeFromTask({ members: [{ id: "ou_y", role: "follower" }] })).toBeUndefined();
    expect(assigneeFromTask(undefined)).toBeUndefined();
  });
  it("统一判定：负责人永远优先；描述 agent 值不再当执行人（2026-10-20）", () => {
    expect(executorOfTask({ members: [{ id: "ou_x", role: "assignee" }], description: "" })).toBeTypeOf("string");
    expect(executorOfTask({ members: [], description: "执行者：张三" })).toBe("张三");
    expect(executorOfTask({ members: [], description: "执行者：agent" })).toBeUndefined();
    expect(executorOfTask({ members: [], description: "执行者：agentd" })).toBeUndefined();
    expect(executorOfTask({ members: [], description: "工单链接：x" })).toBeUndefined();
    expect(executorOfTask(undefined)).toBeUndefined();
  });
  it("描述执行者标记遇到括号/后缀/半角冒号即停（【执行者：agent】不得误判人工）", () => {
    expect(executorOfTask({ members: [], description: "【执行者：agent】" })).toBeUndefined();
    expect(executorOfTask({ members: [], description: "【执行者：agent】目标xx" })).toBeUndefined();
    expect(executorOfTask({ members: [], description: "执行者:agent，负责发布" })).toBeUndefined();
    expect(executorOfTask({ members: [], description: "【执行者：agent】目标xx" })).not.toBe("agent】目标xx");
    expect(executorOfTask({ members: [], description: "执行者：张三】" })).toBe("张三");
    expect(executorOfTask({ members: [], description: "执行者:张三，负责发布" })).toBe("张三");
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

// ── 「确认 R编号」台账推进断链补修（2026-10-27）───────────────────────────
// 缺陷：P 组扫描 adopt({status:"candidate"})（24h 审核窗口）建出 candidate，
// 而 P 组放行循环准入闸门只认 planned（'if (!["planned"].includes(rec.status))' → continue），
// candidate→planned 的推进此前只在注释里描述、代码从未实现 → 新卡永久死锁：
// 既不被放行、也进不了 D（D 组 approve 走 CAS 要求 planned，candidate 必然失败）。
// 修复：handlePendingConfirm（确认 R编号）核验通过后，除消费候选池外，把
// 关联台账记录（按 feishuTaskGuid 定位）candidate → planned，best-effort 不影响确认结果。
describe("确认 R 编号 → 台账推进 candidate→planned（断链补修）", () => {
  it("状态机允许 candidate → planned（推进步的合法前提）", () => {
    const allowed = TASK_STATUS_TRANSITIONS.candidate;
    expect(allowed).toContain("planned");
  });

  it("candidate → ready 非法：证明必须先经 planned（D 组直派 candidate 会 CAS 失败）", () => {
    expect(TASK_STATUS_TRANSITIONS.candidate).not.toContain("ready");
    expect(TASK_STATUS_TRANSITIONS.planned).toContain("ready");
  });

  it("transition(candidate→planned) 成功后 approve 才能放行（闭环验证）", () => {
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[org/repo] 验证任务",
      status: "candidate",
      origin: { provider: FEISHU_TASK_PROVIDER_ID, guid: "g-chain" },
      projectRef: "org/repo",
    });
    // 死锁态：candidate 直接 approve 必失败（CAS 期望 planned）
    expect(reg.approve(rec.uid, { via: "auto" }).ok).toBe(false);
    // 补断链：推进到 planned
    expect(reg.transition(rec.uid, "planned", "candidate").ok).toBe(true);
    // 现在放行成功
    const approved = reg.approve(rec.uid, { via: "auto" });
    expect(approved.ok).toBe(true);
    expect(reg.get(rec.uid)?.status).toBe("ready");
  });
});

// ── runPlanGate 去重基准仓库（2026-10-21 事故 #152~#261）─────────────────
describe("runPlanGate 去重按目标仓查询", () => {
  const repoOf = (req: Record<string, unknown>): string =>
    String((req as { path?: string }).path ?? "").match(/\/repos\/([^/]+\/[^/]+)\/issues/)?.[1] ?? "";

  it("目标仓已有同名工单时：查重 GET 查目标仓、不 POST 建单", async () => {
    const reports = await runPlanGate(mockCtx((id, req) => {
      const r = req as { method?: string; path?: string };
      if (id.includes("feishu")) {
        if (r.path?.includes("sections/sec-plan/tasks")) {
          return { ok: true, value: { code: 0, data: { items: [
            {
              guid: "task-1",
              summary: "[AIGility-Cloud-Innovation/aigility-harness] https://console.timem.cloud/enterprise/usage 该页面有的账号能看到内容",
              members: [{ role: "assignee", id: "ou_x" }],
            },
          ] } } };
        }
        if (r.path?.includes("/sections") && r.method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "sec-plan", name: "P 计划中" }, { guid: "sec-doing", name: "D 执行中" },
          ] } } };
        }
        if (r.path?.includes("/tasks/task-1") && r.method === "GET") {
          return { ok: true, value: { code: 0, data: { task: { description: "" } } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }
      if (id.includes("gitea")) {
        if (repoOf(r) === "AIGility-Cloud-Innovation/aigility-harness") {
          return { ok: true, value: { status: 200, data: [
            { number: 10, title: "https://console.timem.cloud/enterprise/usage 该页面有的账号能看到内容" },
          ] } };
        }
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (id.includes("llm") || id.includes("inference")) {
        return { ok: true, value: { text: '{"ready": false, "missing": "缺验收"}' } };
      }
      return { ok: true, value: { code: 0, data: [] } };
    }), { tasklistGuid: "list-1" });
    const joined = reports.join("\n");
    expect(joined).toContain("疑似重复");
  });

  it("TASK_AUTO_DISPATCH=0：核对通过不自动挪 D，留 P 待人工（B 闸门只拦机器挪卡）", async () => {
    process.env["TASK_AUTO_DISPATCH"] = "0";
    try {
      const reports = await runPlanGate(mockCtx((id, req) => {
        const r = req as { method?: string; path?: string };
        if (id.includes("feishu")) {
          if (r.path?.includes("sections/sec-plan/tasks")) {
            return { ok: true, value: { code: 0, data: { items: [
              {
                guid: "task-gate",
                summary: "[AIGility-Cloud-Innovation/aigility-harness#88] 闸门验证任务信息齐全",
                members: [{ role: "assignee", id: "ou_x" }],
              },
            ] } } };
          }
          if (r.path?.includes("/sections") && r.method === "GET") {
            return { ok: true, value: { code: 0, data: { items: [
              { guid: "sec-plan", name: "P 计划中" }, { guid: "sec-doing", name: "D 执行中" },
            ] } } };
          }
          if (r.path?.includes("/tasks/task-gate") && r.method === "GET") {
            return { ok: true, value: { code: 0, data: { task: { description: "执行者：张三" } } } };
          }
          return { ok: true, value: { code: 0, data: {} } };
        }
        if (id.includes("gitea")) {
          if ((r.path ?? "").endsWith("/88")) {
            return { ok: true, value: { status: 200, data: { number: 88, title: "闸门验证任务信息齐全", state: "open", html_url: "https://git.example/88" } } };
          }
          return { ok: true, value: { status: 200, data: [] } };
        }
        if (id.includes("llm") || id.includes("inference")) {
          return { ok: true, value: { text: '{"ready": true}' } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }), { tasklistGuid: "list-1" });
      const joined = reports.join("\n");
      expect(joined).toContain("不自动挪 D");
      expect(joined).not.toContain("已挪入");
    } finally {
      delete process.env["TASK_AUTO_DISPATCH"];
    }
  });

  it("TASK_AUTO_DISPATCH=0 时 dispatch-scan 照常扫 D 组派发（0 不再拦 D，B 案）", async () => {
    process.env["TASK_AUTO_DISPATCH"] = "0";
    try {
      const { runDispatchScan } = await import("./task-issue-sync.js");
      const reports = await runDispatchScan(mockCtx((id, req) => {
        const r = req as { method?: string; path?: string };
        if (id.includes("feishu")) {
          if (r.path?.includes("sections/sec-doing/tasks")) {
            return { ok: true, value: { code: 0, data: { items: [
              {
                guid: "task-d1",
                summary: "[AIGility-Cloud-Innovation/aigility-harness#77] D 组工单卡",
              },
            ] } } };
          }
          if (r.path?.includes("/sections") && r.method === "GET") {
            return { ok: true, value: { code: 0, data: { items: [
              { guid: "sec-plan", name: "P 计划中" }, { guid: "sec-doing", name: "D 执行中" },
            ] } } };
          }
          return { ok: true, value: { code: 0, data: {} } };
        }
        if (id.includes("gitea")) {
          if ((r.path ?? "").includes("/77")) {
            return { ok: true, value: { status: 200, data: { number: 77, title: "D 组工单卡", state: "open" } } };
          }
          return { ok: true, value: { status: 200, data: [] } };
        }
        // agentd 走真实 UDS socket：单测环境连不上 → 派发尝试失败但「有尝试」即证明 0 未拦
        return { ok: false, error: "no socket in test" };
      }), { tasklistGuid: "list-1" });
      const joined = reports.join("\n");
      expect(joined.length).toBeGreaterThan(0);
      // 走到派发尝试（失败回执）而非静默 return
      expect(joined).toContain("#77");
    } finally {
      delete process.env["TASK_AUTO_DISPATCH"];
    }
  });

  it("标题【挂起】自动挪「挂起」分组并摘前缀（2026-10-22 拍板：分组即状态）", async () => {
    const calls: Array<{ method?: string; path?: string; body?: { task?: { summary?: string } } }> = [];
    await runPlanGate(mockCtx((id, req) => {
      const r = req as { method?: string; path?: string; body?: { task?: { summary?: string } } };
      if (id.includes("feishu")) {
        calls.push(r);
        if (r.path?.includes("sections/sec-plan/tasks")) {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "task-pause", summary: "【挂起】等兰锦宇接口文档的任务", members: [{ role: "assignee", id: "ou_x" }] },
          ] } } };
        }
        if (r.path?.includes("/sections") && r.method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "sec-plan", name: "P 计划中" }, { guid: "sec-doing", name: "D 执行中" },
            { guid: "sec-check", name: "C 待测试" }, { guid: "sec-fix", name: "A 待修复" },
            { guid: "sec-paused", name: "挂起" },
          ] } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { status: 200, data: [] } };
    }), { tasklistGuid: "list-1" });
    // ① 标题摘【挂起】前缀
    if (!calls.some((c) => c.method === "PATCH")) {
      console.error("DEBUG feishu calls:", JSON.stringify(calls.map((c) => `${c.method ?? "?"} ${c.path}`)).slice(0, 800));
    }
    const patch = calls.find((c) => c.method === "PATCH" && (c.path ?? "").includes("tasks/task-pause"));
    expect(patch?.body?.task?.summary).toBe("等兰锦宇接口文档的任务");
    // ② 挪进「挂起」分组（add_tasklist + section_guid）
    const move = calls.find((c) => (c.path ?? "").includes("/tasks/task-pause/add_tasklist") && (c.body as { section_guid?: string } | undefined)?.section_guid === "sec-paused");
    expect(move).toBeTruthy();
  });

  it("两仓 stub：默认仓（GITEA_DEFAULT_REPO）查询不被用于目标仓判定", async () => {
    const seenPaths: string[] = [];
    await runPlanGate(mockCtx((id, req) => {
      const r = req as { method?: string; path?: string };
      if (id.includes("feishu")) {
        if (r.path?.includes("sections/sec-plan/tasks")) {
          return { ok: true, value: { code: 0, data: { items: [
            {
              guid: "task-1",
              // 独立仓库前缀：避开其他用例已写入的模块级 openIssueTitlesByRepo 缓存
              summary: "[TiMEM-AI/timem-project] 完全新任务没有重复",
              members: [{ role: "assignee", id: "ou_x" }],
            },
          ] } } };
        }
        if (r.path?.includes("/sections") && r.method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "sec-plan", name: "P 计划中" }, { guid: "sec-doing", name: "D 执行中" },
          ] } } };
        }
        if (r.path?.includes("/tasks/task-1") && r.method === "GET") {
          return { ok: true, value: { code: 0, data: { task: { description: "执行者：张三" } } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }
      if (id.includes("gitea")) {
        if (r.method === "GET" && (r.path ?? "").includes("/issues")) {
          seenPaths.push(repoOf(r));
          // 目标仓返空（无重复）
          return { ok: true, value: { status: 200, data: [] } };
        }
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (id.includes("llm") || id.includes("inference")) {
        return { ok: true, value: { text: '{"ready": true}' } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    }), { tasklistGuid: "list-1" });
    // 关键断言：查重 GET 必须打到卡标题解析的目标仓，而不是无参默认仓
    expect(seenPaths.length).toBeGreaterThan(0);
    for (const p of seenPaths) expect(p).toBe("TiMEM-AI/timem-project");
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

  it("私聊（无 session_id）拒绝认领（条目存在时才轮到会话校验）", async () => {
    const item = addPendingCandidate(
      "oc_a",
      { title: "t", priority: "P1", fromDigest: true, suggestedRepo: "org/r1" },
      ["org/r1"],
    );
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "org/r1" } },
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
    expect(r.value.response).toContain("没有找到待核验任务 #9");
  });

  it("认领放宽：异群回复可认领；摘要条目（fromDigest）走记录模式不建单", async () => {
    const item = addPendingCandidate(
      "oc_a",
      { title: "修白屏", priority: "P1", fromDigest: true, suggestedRepo: "org/r1" },
      ["org/r1"],
    );
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用（记录模式零调用）");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "org/r1" }, session_id: "oc_b" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("已记录");
    expect(r.value.response).toContain("org/r1");
    // 记录模式保留队列项（等「确认 N」核验），归属写回候选
    const kept = peekPendingCandidate("oc_a", item.no);
    expect(kept).toBeDefined();
    expect(kept?.assignedRepo).toBe("org/r1");
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
    expect(r.value.response).toContain("解析不出项目/仓库");
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

  it("跳过任务 N：认领放宽，异群回复也能丢弃（摘要统一播机器人群）", async () => {
    const item = addPendingCandidate("oc_a", { title: "t", priority: "P1" }, ["org/r1"]);
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r1 = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-skip", ref: String(item.no) }, session_id: "oc_b" },
      ctx,
    );
    if (!r1.ok) throw new Error("execute failed");
    expect(r1.value.response).toContain("已丢弃");
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

// ── 飞书先行链路：create-planned 原语 + 归属确认改标题 + 回填建单闸门 ──

import { repoFromPlannedSummary, resolveWaitingDecisionTask } from "./task-issue-sync.js";

// 2026-10-22 决策寻任务回归（机器人群诊断）：短序号「决策 1」仅唯一待决策时对号
describe("resolveWaitingDecisionTask — 短序号/尾码/uid 三态", () => {
  const two = [{ uid: "tsk_8f3e71bc-f53c-4045" }, { uid: "tsk_aaaa-bbbb-cccc" }];
  it("尾码(≥4)命中", () => {
    expect(resolveWaitingDecisionTask(two, "4045")?.uid).toBe("tsk_8f3e71bc-f53c-4045");
  });
  it("短序号仅唯一待决策任务时对号（播报教「决策 1 1」）", () => {
    expect(resolveWaitingDecisionTask([two[0]], "1")?.uid).toBe("tsk_8f3e71bc-f53c-4045");
    expect(resolveWaitingDecisionTask(two, "1")).toBeUndefined();
  });
  it("uid 全号精确命中", () => {
    expect(resolveWaitingDecisionTask(two, "tsk_aaaa-bbbb-cccc")?.uid).toBe("tsk_aaaa-bbbb-cccc");
  });
});

describe("repoFromPlannedSummary — 飞书先行标题前缀解析", () => {
  it("从 [org/repo] 前缀解析仓库；2026-10-20 起兼容 [#N] 工单引用与【agent】前缀", () => {
    expect(repoFromPlannedSummary("[AIGility/x] 修白屏")).toBe("AIGility/x");
    expect(repoFromPlannedSummary("[P1] 修白屏")).toBeUndefined();
    // 【agent】+[#N] 完整形态（用户标题格式，2026-10-20 拍板 #N 保留在标题）
    expect(repoFromPlannedSummary("【agent】[AIGility/x#7] 修白屏")).toBe("AIGility/x");
    expect(repoFromPlannedSummary("[AIGility/x#7] 修白屏")).toBe("AIGility/x");
    expect(repoFromPlannedSummary(undefined)).toBeUndefined();
  });
});

describe("create-planned 原语 — 飞书先行建计划任务", () => {
  it("建任务（[P1] 标题、无 [repo#N] 前缀）并挂 org 清单 P 分组，回传 guid", async () => {
    const bodies: Record<string, unknown>[] = [];
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (!id.includes("feishu")) return { ok: true, value: { status: 200, data: [] } };
      if (path.endsWith("/tasklists") && method === "GET") return { ok: true, value: { code: 0, data: { items: [{ guid: "tl-9", name: "PlannedOrg" }] } } };
      if (path.endsWith("/sections") && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" }, { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" }] } } };
      }
      if (path === "/open-apis/task/v2/tasks" && method === "POST") {
        bodies.push(req as Record<string, unknown>);
        return { ok: true, value: { code: 0, data: { task: { guid: "tg-9" } } } };
      }
      if (path.includes("/add_tasklist")) {
        bodies.push(req as Record<string, unknown>);
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "create-planned", repo: "PlannedOrg/x", title: "修白屏", priority: "P1", sourceChatId: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.taskGuid).toBe("tg-9");
    expect(r.value.response).toContain("P 计划中");
    const createBody = (bodies.find((b) => (b as { body?: { summary?: string } }).body?.summary) as { body?: { summary?: string; description?: string } }).body;
    expect(createBody.summary).toBe("[P1] 修白屏");
    expect(createBody.summary).not.toContain("#");
    expect(createBody.description).toContain("来源群：oc_a");
    const attachBody = (bodies.find((b) => (b as { body?: { tasklist_guid?: string } }).body?.tasklist_guid) as { body?: { tasklist_guid?: string; section_guid?: string } }).body;
    expect(attachBody.tasklist_guid).toBe("tl-9");
    expect(attachBody.section_guid).toBe("s-p");
  });
});

describe("澄清归属（飞书先行）— 改标题不建工单", () => {
  afterEach(() => clearPendingCandidates());

  it("候选带任务 guid：改写标题为 [repo] 原标题 + 挂目标清单 P 分组，不调 Gitea 建单，候选保留", async () => {
    const item = addPendingCandidate("oc_a", { title: "修白屏", priority: "P1", feishuTaskGuid: "tg-1" }, ["AIGility/x", "AIGility/y"]);
    const calls: string[] = [];
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("gitea")) {
        calls.push(`gitea ${method} ${path}`);
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (path === `/open-apis/task/v2/tasks/tg-1` && method === "PATCH") {
        calls.push(`patch ${JSON.stringify((req as { body?: { task?: { summary?: string } } }).body?.task)}`);
        return { ok: true, value: { code: 0, data: {} } };
      }
      if (path.endsWith("/tasklists") && method === "GET") return { ok: true, value: { code: 0, data: { items: [{ guid: "tl-x", name: "AIGility" }] } } };
      if (path.endsWith("/sections") && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" }, { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" }] } } };
      }
      if (path.includes("/add_tasklist")) {
        calls.push("add_tasklist");
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "AIGility/y" }, session_id: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("已确认归属 AIGility/y");
    expect(r.value.response).toContain("安排执行者");
    expect(calls.some((c) => c.startsWith("gitea POST"))).toBe(false); // 不建工单
    expect(calls.some((c) => c.includes('"[AIGility/y] 修白屏"'))).toBe(true);
    expect(calls).toContain("add_tasklist");
    // 候选保留（回填 assignedRepo），供「安排执行者 N」按编号定位
    expect(peekPendingCandidate("oc_a", item.no)).toBeDefined();
  });

  it("重复确认同一仓库 → 幂等提示", async () => {
    const item = addPendingCandidate("oc_a", { title: "t", priority: "P1", feishuTaskGuid: "tg-2" }, ["AIGility/x"]);
    item.assignedRepo = "AIGility/x";
    const ctx = mockCtx(() => {
      throw new Error("不应发起任何 API 调用");
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "pending-assign", ref: String(item.no), repo: "AIGility/x" }, session_id: "oc_a" },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("无需重复确认");
  });
});

describe("安排执行者（飞书先行）— 按澄清编号定位", () => {
  afterEach(() => clearPendingCandidates());

  it("编号命中候选 → 按任务 guid 写描述「执行者：X」，不评论工单", async () => {
    // 隔离真实人员登记表（测试机 config/ 里有真成员，会让「张三」被别名反问拦截）
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emptyReg = join(mkdtempSync(join(tmpdir(), "reg-")), "team.json");
    writeFileSync(emptyReg, JSON.stringify({ version: 2, members: [] }), "utf-8");
    const savedReg = process.env.TEAM_IDENTITY_REGISTRY;
    process.env.TEAM_IDENTITY_REGISTRY = emptyReg;
    const item = addPendingCandidate("oc_a", { title: "修白屏", priority: "P1", feishuTaskGuid: "tg-3" }, ["AIGility/x"]);
    const calls: string[] = [];
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("gitea")) {
        calls.push(`gitea ${method} ${path}`);
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (path === "/open-apis/task/v2/tasks" && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "tg-3", summary: "[P1] 修白屏", description: "", members: [] }] } } };
      }      // 登记表为空 → 名册查不到 open_id → 走飞书用户搜索；mock 命中即设负责人
      if (path === "/open-apis/search/v1/user") {
        return { ok: true, value: { code: 0, data: { users: [{ open_id: "ou_zhangsan", name: "张三" }] } } };
      }
      if (path === "/open-apis/task/v2/tasks/tg-3/add_members" && method === "POST") {
        calls.push("add_members assignee");
        return { ok: true, value: { code: 0, data: {} } };
      }
      if (path === "/open-apis/task/v2/tasks/tg-3" && method === "PATCH") {
        calls.push(`patch ${JSON.stringify((req as { body?: { task?: { description?: string } } }).body?.task?.description)}`);
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "assign", ref: String(item.no), executor: "@张三" } },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain(`澄清任务 #${item.no}`);
    expect(r.value.response).toContain("张三");
    expect(calls).toContain("add_members assignee"); // 负责人已设置（主判据）
    expect(calls.some((c) => c.includes("执行者：张三"))).toBe(true); // 描述标记双保险仍在
    expect(calls.some((c) => c.startsWith("gitea POST"))).toBe(false); // 未建单不评论工单
    if (savedReg === undefined) delete process.env.TEAM_IDENTITY_REGISTRY;
    else process.env.TEAM_IDENTITY_REGISTRY = savedReg;
  });

  it("工单先行路径：设负责人后回写工单 assignee（登记表有 gitea 用户名）", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const regPath = join(mkdtempSync(join(tmpdir(), "reg-")), "team.json");
    writeFileSync(
      regPath,
      JSON.stringify({ version: 2, members: [{ name: "张三", aliases: [], gitea_usernames: ["zhangsan"], feishu_open_ids: ["ou_zhangsan"] }] }),
      "utf-8",
    );
    const savedReg = process.env.TEAM_IDENTITY_REGISTRY;
    process.env.TEAM_IDENTITY_REGISTRY = regPath;
    const calls: string[] = [];
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("gitea")) {
        calls.push(`gitea ${method} ${path}`);
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (path === "/open-apis/task/v2/tasks" && method === "GET") {
        return {
          ok: true,
          value: { code: 0, data: { items: [{ guid: "tg-4", summary: "[AIGility/x#7] 修白屏", description: "工单链接：https://g/x/7", members: [] }] } },
        };
      }
      if (path === "/open-apis/task/v2/tasks/tg-4/add_members" && method === "POST") {
        calls.push("add_members assignee");
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const r = await taskIssueSyncProvider.execute(
      { mode: "intent", intent: { kind: "assign", ref: "#7", executor: "@张三" } },
      ctx,
    );
    if (!r.ok) throw new Error("execute failed");
    expect(calls).toContain("add_members assignee"); // 飞书负责人已设
    expect(calls).toContain("gitea PATCH /api/v1/repos/AIGility/x/issues/7"); // 工单 assignee 回写
    expect(r.value.response).toContain("工单 assignee 已设 zhangsan");
    if (savedReg === undefined) delete process.env.TEAM_IDENTITY_REGISTRY;
    else process.env.TEAM_IDENTITY_REGISTRY = savedReg;
  });
});

describe("plan-gate 顺序（飞书先行）— 先执行者闸门，后回填建单", () => {
  /** 构造 P 分组只有一条任务的 scan mock；记录关键调用 */
  function planGateCtx(
    task: { summary: string; description?: string; members?: Array<{ id?: string; role?: string; type?: string }> },
    log: string[],
  ) {
    return mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("llm")) return { ok: true, value: { text: '{"ready":true}' } };
      if (id.includes("gitea")) {
        if (method === "POST" && path.endsWith("/issues")) {
          log.push(`create-issue:${JSON.stringify((req as { body?: { title?: string } }).body?.title)}`);
          return { ok: true, value: { status: 201, data: { number: 7, html_url: "https://g/x/7" } } };
        }
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (path.endsWith("/sections") && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" }, { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" }] } } };
      }
      if (path === `/open-apis/task/v2/sections/s-p/tasks` && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "tg-p", summary: task.summary, description: task.description, members: task.members ?? [] }] } } };
      }
      if (path.startsWith("/open-apis/task/v2/tasks/tg-p") && method === "PATCH") {
        log.push(`patch:${JSON.stringify((req as { body?: { task?: { summary?: string } } }).body?.task?.summary)}`);
        return { ok: true, value: { code: 0, data: {} } };
      }
      if (path === "/open-apis/task/v2/tasks" && method === "POST") {
        return { ok: true, value: { code: 0, data: { task: { guid: "tg-new" } } } };
      }
      if (path.includes("/add_tasklist")) return { ok: true, value: { code: 0, data: {} } };
      return { ok: true, value: { code: 0, data: {} } };
    });
  }

  it("仅缺执行人（仓库已齐备）→ 只打【待安排执行者】，提示「执行者 #N @人名」，不建工单", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg1" },
      planGateCtx({ summary: "[AIGility/x] 修白屏" }, log),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("尚未安排执行者");
    expect(r.value.response).toContain("执行者 编号 @人名");
    expect(r.value.response).not.toContain("任务归属");
    expect(log.some((l) => l.startsWith("create-issue"))).toBe(false);
    expect(log.some((l) => l.includes("【待安排执行者】"))).toBe(true);
    expect(log.some((l) => l.includes("【待确认仓库】"))).toBe(false);
  });

  it("仅缺仓库（执行人已明确）→ 只打【待确认仓库】，提示「任务归属 编号 @仓库」，不建工单", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg2" },
      planGateCtx({ summary: "修白屏", description: "执行者：张三" }, log),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("尚未确认归属");
    expect(r.value.response).toContain("任务归属 编号 @仓库");
    expect(r.value.response).not.toContain("尚未安排执行者");
    expect(log.some((l) => l.startsWith("create-issue"))).toBe(false);
    expect(log.some((l) => l.includes("【待确认仓库】"))).toBe(true);
    expect(log.some((l) => l.includes("【待安排执行者】"))).toBe(false);
  });

  it("两者都缺 → 优先执行人闸门：只打【待安排执行者】，不出现【待确认仓库】", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg-both" },
      planGateCtx({ summary: "修白屏" }, log),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("尚未安排执行者");
    expect(r.value.response).toContain("执行者 编号 @人名");
    expect(r.value.response).not.toContain("任务归属");
    expect(log.some((l) => l.startsWith("create-issue"))).toBe(false);
    expect(log.some((l) => l.includes("【待安排执行者】"))).toBe(true);
    expect(log.some((l) => l.includes("【待确认仓库】"))).toBe(false);
  });

  it("真人负责人 + 历史【待确认仓库】标签 → 摘牌后进入目标核对，不再要求确认仓库", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg-assignee-tag" },
      planGateCtx(
        {
          summary: "【待确认仓库】修白屏",
          members: [{ id: "ou_zhangsan", role: "assignee", type: "user" }],
        },
        log,
      ),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("摘除【待确认仓库】标签");
    expect(r.value.response).toContain("核对通过");
    expect(log.some((l) => l === 'patch:"修白屏"')).toBe(true);
    expect(log.some((l) => l.startsWith("create-issue"))).toBe(false);
  });

  it("真人负责人（assignee 有值）且无仓库 → 不再要求确认仓库，直接进入目标核对", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg-assignee" },
      planGateCtx(
        { summary: "修白屏", members: [{ id: "ou_zhangsan", role: "assignee", type: "user" }] },
        log,
      ),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).not.toContain("尚未确认归属");
    expect(r.value.response).not.toContain("【待确认仓库】");
    expect(r.value.response).toContain("核对通过");
    expect(log.some((l) => l.startsWith("create-issue"))).toBe(false);
    expect(log.some((l) => l.includes("【待确认仓库】"))).toBe(false);
  });

  it("描述执行者 + 标题 [org/repo#N] + 历史【待确认仓库】→ 摘牌进入执行，不再要求确认仓库", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg-desc-repo-tag" },
      planGateCtx(
        { summary: "【待确认仓库】[AIGility/x#7] 修白屏", description: "执行者：张三" },
        log,
      ),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("摘除【待确认仓库】标签");
    expect(r.value.response).toContain("核对通过");
    expect(r.value.response).not.toContain("尚未确认归属");
    expect(log.some((l) => l === 'patch:"[AIGility/x#7] 修白屏"')).toBe(true);
    expect(log.some((l) => l.includes("【待确认仓库】"))).toBe(false);
  });

  it("执行者+归属齐备（[org/repo] 前缀）→ 从标题解析仓库回填建工单", async () => {
    const log: string[] = [];
    const r = await taskIssueSyncProvider.execute(
      { mode: "scan", tasklistGuid: "tl-pg3" },
      planGateCtx({ summary: "[AIGility/y] 修白屏", description: "执行者：李四" }, log),
    );
    if (!r.ok) throw new Error("execute failed");
    expect(r.value.response).toContain("已回填工单 AIGility/y#7");
    expect(log).toContain('create-issue:"修白屏"');
  });

  it("回填建单：工单描述带任务链接 + 飞书负责人→工单指派人（2026-10-13 需求）", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const regPath = join(mkdtempSync(join(tmpdir(), "reg-link-")), "team.json");
    writeFileSync(
      regPath,
      JSON.stringify({ version: 2, members: [{ name: "王五", aliases: [], gitea_usernames: ["wangwu"], feishu_open_ids: ["ou_wangwu"] }] }),
      "utf-8",
    );
    const savedReg = process.env.TEAM_IDENTITY_REGISTRY;
    process.env.TEAM_IDENTITY_REGISTRY = regPath;
    const log: string[] = [];
    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("llm")) return { ok: true, value: { text: '{"ready":true}' } };
      if (id.includes("gitea")) {
        if (method === "POST" && path.endsWith("/issues")) {
          const body = (req as { body?: { body?: string; assignees?: string[] } }).body;
          log.push(`create-issue:${JSON.stringify({ assignees: body?.assignees, hasLink: /任务链接：https\:\/\/www\.feishu\.cn\/task\//.test(body?.body ?? "") })}`);
          return { ok: true, value: { status: 201, data: { number: 9, html_url: "https://g/y/9" } } };
        }
        return { ok: true, value: { status: 200, data: [] } };
      }
      if (path.endsWith("/sections") && method === "GET") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" }, { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" }] } } };
      }
      if (path === "/open-apis/task/v2/sections/s-p/tasks" && method === "GET") {
        // 任务带负责人（open_id ou_wangwu）→ 应映射为 gitea 指派人 wangwu
        return { ok: true, value: { code: 0, data: { items: [{ guid: "tg-link", summary: "[AIGility/y] 加导出功能", description: "执行者：王五", url: "https://www.feishu.cn/task/tg-link", members: [{ id: "ou_wangwu", role: "assignee", type: "user" }] }] } } };
      }
      if (path === "/open-apis/task/v2/tasks" && method === "POST") {
        return { ok: true, value: { code: 0, data: { task: { guid: "tg-new" } } } };
      }
      if (path.includes("/add_tasklist")) return { ok: true, value: { code: 0, data: {} } };
      return { ok: true, value: { code: 0, data: {} } };
    });
    try {
      const r = await taskIssueSyncProvider.execute({ mode: "scan", tasklistGuid: "tl-link1" }, ctx);
      if (!r.ok) throw new Error("execute failed");
      expect(r.value.response).toContain("已回填工单 AIGility/y#9");
      expect(log.some((l) => l.includes('"assignees":["wangwu"]'))).toBe(true);
      expect(log.some((l) => l.includes('"hasLink":true'))).toBe(true);
    } finally {
      if (savedReg === undefined) delete process.env.TEAM_IDENTITY_REGISTRY;
      else process.env.TEAM_IDENTITY_REGISTRY = savedReg;
    }
  });
});

describe("resolveChatName 群名解析", () => {
  it("解析群名并缓存（同一 chatId 只调一次接口），* 返回未知", async () => {
    let calls = 0;
    const ctx = {
      call: async () => {
        calls += 1;
        return { ok: true, value: { code: 0, data: { name: "NX 电信群" } } };
      },
    } as never;
    const { resolveChatName } = await import("./task-issue-sync.js");
    expect(await resolveChatName(ctx, "oc_abc")).toBe("NX 电信群");
    expect(await resolveChatName(ctx, "oc_abc")).toBe("NX 电信群");
    expect(calls).toBe(1); // 缓存生效
    expect(await resolveChatName(ctx, "*")).toBe("未知");
    expect(calls).toBe(1);
  });
});

// 2026-10-28 实测事故（tsk_58cd3997）：卡片先以无前缀标题入册（adopt 定型 projectRef=空），
// 之后补上 [org/repo] 再挪 D 放行——放行判定读当前标题通过，台账却永远没有仓库，
// 派发得到 cwd=undefined → 「任务无 cwd」交付失败。放行时必须把仓库回填进台账。
describe("D 组放行回填仓库（2026-10-28 事故 tsk_58cd3997）", () => {
  it("首入册无 projectRef、放行标题带 [org/repo] → 回填并置 ready", async () => {
    const { runDispatchScan, setPlanGateRegistry } = await import("./task-issue-sync.js");
    const reg = new TaskRegistry(undefined);
    const seeded = reg.adopt({
      title: "timem console新建峰谷策略，只能选配豁免企业组织 ID",
      status: "planned",
      origin: { provider: FEISHU_TASK_PROVIDER_ID, guid: "tg-peak" },
    } as never);
    expect(seeded.projectRef).toBeUndefined();
    setPlanGateRegistry(reg);

    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("feishu")) {
        if (path.endsWith("/sections") && method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" },
            { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" },
          ] } } };
        }
        if (path === "/open-apis/task/v2/sections/s-d/tasks" && method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "tg-peak", summary: "【agent】[TiMEM-AI/timem_console_frontend] 峰谷策略支持生效企业组织 ID" },
          ] } } };
        }
        if (path.includes("/tasks/tg-peak") && method === "GET") {
          return { ok: true, value: { code: 0, data: { task: { description: "" } } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { status: 200, data: [] } };
    });

    const reports = await runDispatchScan(ctx, { tasklistGuid: "tl-backfill" });
    expect(reports.join("\n")).toContain("agent 任务完备（D 组放行）");
    const rec = reg.get(seeded.uid)!;
    expect(rec.projectRef).toBe("TiMEM-AI/timem_console_frontend");
    expect(rec.status).toBe("ready");
  });

  // 2026-10-28 实测：needs-input 打的 ❓ 标在决策重入队后仍挂在标题上，
  // D 组扫描的 ^【agent】 与 [org/repo] 解析均因前缀失配 → 已决策过的卡被
  // 「信息不全（缺工单号且未标 agent）」误判挪回 P。剥 ❓ 后应正常放行。
  it("❓ 等决策标残留 → 剥前缀后仍按 agent 完备放行", async () => {
    const { runDispatchScan, setPlanGateRegistry } = await import("./task-issue-sync.js");
    const reg = new TaskRegistry(undefined);
    const seeded = reg.adopt({
      title: "【agent】[TiMEM-AI/timem_console_frontend] 峰谷策略支持生效企业组织 ID",
      status: "planned",
      projectRef: "TiMEM-AI/timem_console_frontend",
      origin: { provider: FEISHU_TASK_PROVIDER_ID, guid: "tg-qmark" },
    } as never);
    setPlanGateRegistry(reg);

    const ctx = mockCtx((id, req) => {
      const path = String((req as { path?: string }).path);
      const method = String((req as { method?: string }).method);
      if (id.includes("feishu")) {
        if (path.endsWith("/sections") && method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "s-p", name: "P 计划中" }, { guid: "s-d", name: "D 执行中" },
            { guid: "s-c", name: "C 待测试" }, { guid: "s-a", name: "A 待修复" },
          ] } } };
        }
        if (path === "/open-apis/task/v2/sections/s-d/tasks" && method === "GET") {
          return { ok: true, value: { code: 0, data: { items: [
            { guid: "tg-qmark", summary: "❓【agent】[TiMEM-AI/timem_console_frontend] 峰谷策略支持生效企业组织 ID" },
          ] } } };
        }
        if (path.includes("/tasks/tg-qmark") && method === "GET") {
          return { ok: true, value: { code: 0, data: { task: { description: "" } } } };
        }
        return { ok: true, value: { code: 0, data: {} } };
      }
      return { ok: true, value: { status: 200, data: [] } };
    });

    const reports = await runDispatchScan(ctx, { tasklistGuid: "tl-qmark" });
    expect(reports.join("\n")).toContain("agent 任务完备（D 组放行）");
    expect(reports.join("\n")).not.toContain("信息不全");
    expect(reg.get(seeded.uid)!.status).toBe("ready");
  });
});
