import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import {
  extractRepoSpec,
  parseTaskIntent,
  feishuTaskAssistantProvider,
  llmInferenceRefForPersona,
  recordAssistantTurn,
  resetAssistantConversationBuffers,
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

  it("我的任务新触发词：安排类问法", () => {
    for (const text of ["我的安排", "任务安排", "工作安排", "最近做什么", "我在做什么"]) {
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

  it("手动对齐（立即对齐及变体）", () => {
    for (const text of ["立即对齐", "手动对齐", "马上对齐", "对齐一下", "同步一下"]) {
      expect(parseTaskIntent(text)).toEqual({ kind: "align-now" });
    }
    // 非整条指令不误触发
    expect(parseTaskIntent("帮我把数据对齐一下格式").kind).toBe("help");
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

  it("兜底请求形状：模型/消息/max_tokens/userId 完整（RSI 召回/沉淀在外围，LLM 请求形状不变）", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({
        ok: true,
        value: { text: "好" },
      }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "嗨" }, ctx);
    // 2026-10-10 起：无 user_id（或未绑定花名册）→ 不召回不沉淀，只调 LLM
    expect(ctx.calls.length).toBe(1);
    const llm = (ctx.calls as Array<{ id: string; req: Record<string, unknown> }>).find(
      (c) => c.id === llmInferenceRefForPersona.id,
    );
    expect(llm).toBeDefined();
    const req = llm!.req;
    expect(req["model"]).toBeTypeOf("string");
    // 1500：推理型模型的思考 tokens 计入 max_tokens，500 会被思考耗尽致正文为空
    expect(req["max_tokens"]).toBe(1500);
    expect(req["userId"]).toBe("feishu-task-assistant-fallback");
    const messages = req["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("项目小助理");
    expect(messages[1]).toEqual({ role: "user", content: "嗨" });
  });

  it("「我的任务」→ briefing 人视角汇总（briefing 可用时）", async () => {
    const ctx = mockCtx({
      "@orchestration/project-briefing": () => ({
        ok: true,
        value: { response: "📋 你的任务安排全景" },
      }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "我的任务", user_id: "ou_test" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(ctx.calls.length).toBe(1);
    expect((ctx.calls as unknown[])[0]).toMatchObject({
      id: "@orchestration/project-briefing",
      req: { mode: "person-brief", user_id: "ou_test" },
    });
    if (r.ok) expect(r.value.response).toContain("任务安排全景");
  });

  it("「我的任务」briefing 不可用 → 回落编排层任务列表（不比改动前差）", async () => {
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
    expect(ctx.calls.length).toBe(2);
    expect((ctx.calls as unknown[])[0]).toMatchObject({ id: "@orchestration/project-briefing" });
    expect((ctx.calls as unknown[])[1]).toMatchObject({ id: "@orchestration/task-issue-sync" });
    if (r.ok) expect(r.value.response).toBe("已建任务");
  });

  it("「项目进展」与「反馈」→ briefing 对应模式", async () => {
    const ctx = mockCtx({
      "@orchestration/project-briefing": (req) => {
        const mode = (req as { mode?: string }).mode;
        if (mode === "project-brief") return { ok: true, value: { response: "📊 TiMEM 平台进展" } };
        return { ok: true, value: { response: "✅ 反馈已记入" } };
      },
    });
    const p = await feishuTaskAssistantProvider.execute({ user_input: "项目进展 timem" }, ctx);
    expect(p.ok).toBe(true);
    expect((ctx.calls as unknown[])[0]).toMatchObject({
      id: "@orchestration/project-briefing",
      req: { mode: "project-brief", project: "timem" },
    });
    if (p.ok) expect(p.value.response).toContain("进展");

    const f = await feishuTaskAssistantProvider.execute(
      { user_input: "反馈：周三例会改到上午", user_id: "ou_test" },
      ctx,
    );
    expect(f.ok).toBe(true);
    expect((ctx.calls as unknown[])[1]).toMatchObject({
      id: "@orchestration/project-briefing",
      req: { mode: "feedback", text: "周三例会改到上午", user_id: "ou_test" },
    });
    if (f.ok) expect(f.value.response).toContain("反馈已记入");
  });
});

// ── 多行建任务 + 兜底防编造（#1234 事件回归） ─────────────────────────

describe("parseTaskIntent — 多行建任务（带图/带描述消息）", () => {
  it("建任务 @仓库 多行：首行标题、其余为描述", () => {
    expect(
      parseTaskIntent("建任务 @video：修复登录页白屏\n报错：点击导出无响应\n截图见群聊"),
    ).toEqual({
      kind: "create",
      title: "修复登录页白屏",
      repo: "video",
      description: "报错：点击导出无响应\n截图见群聊",
    });
  });

  it("建任务触发词独占一行（#1234 消息形态：标题在下一行）→ 取首个非空行为标题", () => {
    expect(
      parseTaskIntent(
        "建任务：@platform-backend\n\n账单导出功能会在导出记录中下载到奇怪的表格（期望得到费用账单，但现在表格中没有体现）",
      ),
    ).toEqual({
      kind: "create",
      repo: "platform-backend",
      title:
        "账单导出功能会在导出记录中下载到奇怪的表格（期望得到费用账单，但现在表格中没有体现）",
    });
  });

  it("建任务多行缺 @仓库 → 反问（用户带 @仓库 重发后全量重新解析，不写数据）", () => {
    expect(parseTaskIntent("建任务：账单导出异常\n导出的表格没有费用列")).toEqual({
      kind: "task-need-repo",
      title: "账单导出异常",
    });
  });

  it("extractRepoSpec 保留多行结构（只压横向空白，换行不压平）", () => {
    expect(extractRepoSpec("建任务：@platform-backend\n\n账单导出异常")).toEqual({
      text: "建任务： \n\n账单导出异常",
      repo: "platform-backend",
    });
  });
});

describe("isFabricatedReply — 兜底防编造后置过滤", () => {
  it("命中：操作声称 / 具体编号（兜底无工具，构造性为假）", async () => {
    const { isFabricatedReply } = await import("./feishu-task-assistant.js");
    expect(
      isFabricatedReply("好的，已为您在 Gitea 工单中创建任务，工单编号为 #1234，可随时查看进展"),
    ).toBe(true);
    expect(isFabricatedReply("已经帮你完成了")).toBe(true);
    expect(isFabricatedReply("刚刚执行了派发")).toBe(true);
  });

  it("不命中：能力描述与指令引导（不过滤）", async () => {
    const { isFabricatedReply } = await import("./feishu-task-assistant.js");
    expect(isFabricatedReply("可以试试「建任务 @仓库：标题」")).toBe(false);
    expect(isFabricatedReply("我会帮你同步到 Gitea，但需要你先用指令表达")).toBe(false);
    expect(isFabricatedReply("已知不能直接处理截图，请把报错文字贴出来")).toBe(false);
  });

  it("不命中：提议/引导句式（2026-09-30 误杀修复——已然/未然拆分）", async () => {
    const { isFabricatedReply } = await import("./feishu-task-assistant.js");
    expect(
      isFabricatedReply(
        "收到，hongbin 的修改还没合并确实需要跟进一下。需要我帮你建个工单跟踪这件事吗？如果要的话，发我「建工单 @仓库：标题」就行，顺便告诉我这个改动的仓库是哪个？",
      ),
    ).toBe(false);
    expect(isFabricatedReply("可以发「建任务：修复登录页白屏」立个条目")).toBe(false);
  });

  it("命中：受益者句式的完成态声称（帮你…建了/好）", async () => {
    const { isFabricatedReply } = await import("./feishu-task-assistant.js");
    expect(isFabricatedReply("我帮你建好了")).toBe(true);
    expect(isFabricatedReply("已为你创建工单")).toBe(true);
    expect(isFabricatedReply("帮你更新了清单")).toBe(true);
  });
});

describe("feishuTaskAssistantProvider — 兜底防编造集成", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("LLM 兜底编造操作（#1234 场景）→ 整条丢弃回帮助文本", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({
        ok: true,
        value: {
          text: "已为您在 Gitea 工单中创建任务，工单编号为 #1234，您可以随时查看进展。需要我帮您添加其他信息吗？",
        },
      }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "帮我记录一下账单导出的截图问题" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.response).not.toContain("#1234");
      expect(r.value.response).toContain("建任务 @仓库");
    }
  });

  it("兜底无操作声称 → 正常透传", async () => {
    const pass = "可以帮你管理任务和工单。试试「建任务 @仓库：标题」";
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: pass } }),
    });
    const r = await feishuTaskAssistantProvider.execute({ user_input: "你能干嘛" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.response).toBe(pass);
  });

  it("兜底模型默认 deepseek-v4-flash、温度 0.2（.env 可覆盖；空响应根因是推理耗尽 max_tokens，已配套提到 1500）", async () => {
    // 本用例断言的是「无 env 覆盖时的硬编码默认值」，因此必须先真删掉
    // TASK_ASSISTANT_MODEL——否则宿主/CI 导出的同名变量会顶掉默认值，
    // 测试变成在读环境而失败（2026-10-07 定位：注入点即 process.env 本身）。
    // 注意不能用 vi.stubEnv(name, "")：空串仍算「已定义」，而 fallbackModel()
    // 用的是 ??（nullish），空串不会回落默认值，反而断言得到 ""。
    const had = Object.prototype.hasOwnProperty.call(process.env, "TASK_ASSISTANT_MODEL");
    const prev = process.env.TASK_ASSISTANT_MODEL;
    delete process.env.TASK_ASSISTANT_MODEL;
    try {
      const ctx = mockCtx({
        "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好的，可以聊聊" } }),
      });
      await feishuTaskAssistantProvider.execute({ user_input: "随便聊聊" }, ctx);
      const llm = (ctx.calls as Array<{ id: string; req: Record<string, unknown> }>).find(
        (c) => c.id === llmInferenceRefForPersona.id,
      );
      expect(llm).toBeDefined();
      expect(llm!.req["model"]).toBe("deepseek-v4-flash");
      expect(llm!.req["temperature"]).toBe(0.2);
    } finally {
      if (had) process.env.TASK_ASSISTANT_MODEL = prev;
      else delete process.env.TASK_ASSISTANT_MODEL;
    }
  });

  it("TASK_ASSISTANT_MODEL 覆盖默认值（.env 生效路径）", async () => {
    // 补上被上一条用例遗漏的另一半：env 覆盖确实生效。
    // 上一条只验证默认值，一旦有人误删 fallbackModel() 的 env 读取，
    // 上一条仍会通过而无人发现——两条合起来才锁住「默认 + 可覆盖」契约。
    vi.stubEnv("TASK_ASSISTANT_MODEL", "ksyun-deepseek-v4.1-flash");
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好的，可以聊聊" } }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "随便聊聊" }, ctx);
    const llm = (ctx.calls as Array<{ id: string; req: Record<string, unknown> }>).find(
      (c) => c.id === llmInferenceRefForPersona.id,
    );
    expect(llm).toBeDefined();
    expect(llm!.req["model"]).toBe("ksyun-deepseek-v4.1-flash");
  });

  it("免@群消息仅指令模式：未命中意图 → 空回复静默，不调 LLM 兜底", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "不该被调用" } }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "大家下午好", chat_type: "group", mentioned_bot: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.response).toBe("");
    expect(ctx.calls.length).toBe(0);
  });

  it("免@群消息命中指令 → 正常执行（走编排层）", async () => {
    const ctx = mockCtx({
      "@orchestration/task-issue-sync": () => ({ ok: true, value: { response: "✅ 已记录 #1" } }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "确认 1", chat_type: "group", mentioned_bot: false, session_id: "oc_x" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.response).toContain("已记录 #1");
  });
});

// ── RSI 递归自我改进：召回注入 / 对话沉淀 / 反馈学规则 ──────────────

describe("feishuTaskAssistantProvider — RSI 召回/沉淀", () => {
  // 2026-10-10 契约：RSI 读写两半边 user_id 一律映射到成员 space_*（花名册
  // feishu_open_ids → timem_user_ids[0]）；未绑定发言人不召回不沉淀。
  const FIXTURE = join(tmpdir(), `timem-team-registry.fixture.${process.pid}.json`);
  beforeAll(() => {
    writeFileSync(FIXTURE, JSON.stringify({
      version: 1,
      members: [
        { member_id: "m1", name: "张三", feishu_open_ids: ["ou_rsi", "ou_w", "ou_f"], timem_user_ids: ["space_zhang"] },
        { member_id: "m2", name: "李四", feishu_open_ids: [], timem_user_ids: ["space_lisi"] },
      ],
    }));
  });
  afterAll(() => {
    rmSync(FIXTURE, { force: true });
  });
  const stubBound = () => vi.stubEnv("TEAM_IDENTITY_REGISTRY", FIXTURE);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const llmCallOf = (ctx: { calls: Array<{ id: string; req: Record<string, unknown> }> }) =>
    // 取最后一次 LLM 调用（多轮 execute 时前面的调用属于历史轮次）
    [...ctx.calls].reverse().find((c) => c.id === llmInferenceRefForPersona.id)!;

  it("召回命中 → 经验规则与相关记忆注入 system 提示词，user_id 映射到成员空间", async () => {
    stubBound();
    const ctx = mockCtx({
      "@action/timem-rule-recall": () => ({
        ok: true,
        value: {
          rules: [{ name: "仓库归属", lesson: "「nx」仓库指 AIGility-Cloud-Innovation/nx-telecom-opc-platform" }],
          total: 1,
        },
      }),
      "@action/timem-memory": () => ({
        ok: true,
        value: { results: [{ content: "用户偏好把周会安排在上午" }], total: 1 },
      }),
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好的" } }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "nx 是哪个仓库", user_id: "ou_rsi" },
      ctx,
    );
    expect(r.ok).toBe(true);
    const rulesCall = ctx.calls.find((c) => c.id === "@action/timem-rule-recall");
    expect(rulesCall).toBeDefined();
    expect((rulesCall!.req as Record<string, unknown>)["user_id"]).toBe("space_zhang");
    expect((rulesCall!.req as Record<string, unknown>)["agent_id"]).toBe("feishu-task-assistant");
    const messages = (llmCallOf(ctx)!.req["messages"] as Array<{ role: string; content: string }>);
    // M1 前缀缓存：静态 system 在前（不含召回块），召回块是历史之后的独立 system 消息
    expect(messages[0].content).not.toContain("【本次召回的团队经验与记忆】");
    const recallMsg = messages.find((m) => m.role === "system" && m.content.includes("【本次召回的团队经验与记忆】"));
    expect(recallMsg).toBeDefined();
    expect(recallMsg!.content).toContain("nx-telecom-opc-platform");
    expect(recallMsg!.content).toContain("周会");
    // 召回块之后是当前 user 消息（动态内容全部在稳定前缀之后）
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "nx 是哪个仓库" });
    // 无 handler 的记忆写半边降级不报错，回复正常返回
    if (r.ok) expect(r.value.response).toBe("好的");
  });

  it("召回无 handler/失败 → 静默降级：提示词无召回块，LLM 照常作答", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "你好呀" } }),
    });
    const r = await feishuTaskAssistantProvider.execute({ user_input: "嗨" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.response).toBe("你好呀");
    const sys = ((llmCallOf(ctx)!.req["messages"] as Array<{ role: string; content: string }>)[0])
      .content;
    expect(sys).not.toContain("【本次召回的团队经验与记忆】");
  });

  it("TASK_ASSISTANT_RSI=0 → 不召回不沉淀，只调 LLM", async () => {
    vi.stubEnv("TASK_ASSISTANT_RSI", "0");
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好" } }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "嗨" }, ctx);
    expect(ctx.calls.length).toBe(1);
    expect(ctx.calls[0].id).toBe(llmInferenceRefForPersona.id);
  });

  it("未绑定发言人 → 不召回不沉淀，只调 LLM（与群聊沉淀节点同一口径）", async () => {
    stubBound();
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好" } }),
    });
    await feishuTaskAssistantProvider.execute(
      { user_input: "嗨", user_id: "ou_stranger" },
      ctx,
    );
    expect(ctx.calls.length).toBe(1);
    expect(ctx.calls[0].id).toBe(llmInferenceRefForPersona.id);
    expect(ctx.calls.find((c) => c.id === "@action/timem-memory-write")).toBeUndefined();
  });

  it("作答成功 → 本轮问答沉淀 @action/timem-memory-write（user_id 为成员空间）", async () => {
    stubBound();
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "可以发「建任务：标题」" } }),
    });
    await feishuTaskAssistantProvider.execute(
      { user_input: "怎么建任务", user_id: "ou_w" },
      ctx,
    );
    const write = ctx.calls.find((c) => c.id === "@action/timem-memory-write");
    expect(write).toBeDefined();
    const req = write!.req as Record<string, unknown>;
    expect(req["agent_id"]).toBe("feishu-task-assistant");
    expect(req["user_id"]).toBe("space_zhang");
    expect(String(req["content"])).toContain("用户问：怎么建任务");
    expect(String(req["content"])).toContain("小助理答：可以发「建任务：标题」");
  });

  it("LLM 失败回帮助文本 → 不沉淀（垃圾轮不进记忆）", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: false, error: "网关不可用" }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "嗨" }, ctx);
    expect(ctx.calls.find((c) => c.id === "@action/timem-memory-write")).toBeUndefined();
  });

  it("「反馈：以后…」→ briefing 记忆沉淀外追加经验规则固化并提示（规则落成员空间）", async () => {
    stubBound();
    const ctx = mockCtx({
      "@orchestration/project-briefing": () => ({ ok: true, value: { response: "已记下" } }),
      "@action/timem-rule-create": () => ({ ok: true, value: { rule_id: "rule_1" } }),
    });
    const r = await feishuTaskAssistantProvider.execute(
      { user_input: "反馈：以后工单默认建到 nx 仓库", user_id: "ou_f" },
      ctx,
    );
    expect(r.ok).toBe(true);
    const create = ctx.calls.find((c) => c.id === "@action/timem-rule-create");
    expect(create).toBeDefined();
    const req = create!.req as Record<string, unknown>;
    expect(req["lesson"]).toBe("以后工单默认建到 nx 仓库");
    expect(req["user_id"]).toBe("space_zhang");
    expect(req["agent_id"]).toBe("feishu-task-assistant");
    if (r.ok) expect(r.value.response).toContain("经验规则");
  });

  it("「反馈：…」非「以后」开头 → 只走 briefing，不建规则", async () => {
    const ctx = mockCtx({
      "@orchestration/project-briefing": () => ({ ok: true, value: { response: "已记下" } }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "反馈：今天上线很顺利" }, ctx);
    expect(ctx.calls.find((c) => c.id === "@action/timem-rule-create")).toBeUndefined();
  });
});

// ── 短时记忆：per-chat 滚动上下文窗口 ─────────────────────────────

describe("feishuTaskAssistantProvider — 短时记忆窗口", () => {
  beforeEach(() => {
    resetAssistantConversationBuffers();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const llmCallOf = (ctx: { calls: Array<{ id: string; req: Record<string, unknown> }> }) =>
    // 取最后一次 LLM 调用（多轮 execute 时前面的调用属于历史轮次）
    [...ctx.calls].reverse().find((c) => c.id === llmInferenceRefForPersona.id)!;
  const messagesOf = (ctx: { calls: Array<{ id: string; req: Record<string, unknown> }> }) =>
    (llmCallOf(ctx)!.req["messages"] as Array<{ role: string; content: string }>);

  it("同群第二轮兜底 → 上一轮 user/assistant 进入 messages 历史", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "可以发「建任务：标题」" } }),
    });
    await feishuTaskAssistantProvider.execute(
      { user_input: "任务怎么建", session_id: "oc_mem" },
      ctx,
    );
    await feishuTaskAssistantProvider.execute(
      { user_input: "就是刚才那个事", session_id: "oc_mem" },
      ctx,
    );
    const messages = messagesOf(ctx);
    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual({ role: "user", content: "任务怎么建" });
    expect(messages[2]).toEqual({ role: "assistant", content: "可以发「建任务：标题」" });
    expect(messages[3]).toEqual({ role: "user", content: "就是刚才那个事" });
  });

  it("帮助文本兜底轮不记 assistant 半边（垃圾轮不进短时记忆）", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: false, error: "网关不可用" }),
    });
    await feishuTaskAssistantProvider.execute(
      { user_input: "第一条", session_id: "oc_help" },
      ctx,
    );
    await feishuTaskAssistantProvider.execute(
      { user_input: "第二条", session_id: "oc_help" },
      ctx,
    );
    const messages = messagesOf(ctx);
    // 第一轮 user 进了窗口，但 HELP_TEXT 没有以 assistant 身份进
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "user", content: "第一条" });
    expect(messages.map((m) => m.role)).not.toContain("assistant");
  });

  it("群与群隔离：不同 session_id 互不可见", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好" } }),
    });
    recordAssistantTurn("oc_a", "A群的话", "A群的回复");
    await feishuTaskAssistantProvider.execute({ user_input: "B群提问", session_id: "oc_b" }, ctx);
    const messages = messagesOf(ctx);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: "B群提问" });
  });

  it("TASK_ASSISTANT_CONTEXT=0 → 不注入历史，行为回到单轮", async () => {
    vi.stubEnv("TASK_ASSISTANT_CONTEXT", "0");
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好" } }),
    });
    recordAssistantTurn("oc_off", "上一句", "上一答");
    await feishuTaskAssistantProvider.execute({ user_input: "新问题", session_id: "oc_off" }, ctx);
    const messages = messagesOf(ctx);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: "新问题" });
  });

  it("防编造过滤补「已记录/已登记」：推理模型的口头禅也算操作声称", async () => {
    const { isFabricatedReply } = await import("./feishu-task-assistant.js");
    expect(isFabricatedReply("收到✅ 已记录：R42 项目 = timem_console_frontend")).toBe(true);
    expect(isFabricatedReply("已登记为待办任务")).toBe(true);
    expect(isFabricatedReply("你说的我记下来了，可以发「建任务：标题」正式立条")).toBe(false);
  });
});

// ── assign 意图：「安排执行者 #N @姓名」 ─────────────────────────────

describe("parseTaskIntent — assign 安排执行者", () => {
  it("标准形式（带 @）", async () => {
    const { parseTaskIntent } = await import("./feishu-task-assistant.js");
    expect(parseTaskIntent("安排执行者 #12 @张三")).toEqual({
      kind: "assign",
      ref: "12",
      executor: "张三",
    });
  });

  it("简写形式（不带 @、不带「执行者」）", async () => {
    const { parseTaskIntent } = await import("./feishu-task-assistant.js");
    expect(parseTaskIntent("安排 7 李四")).toEqual({ kind: "assign", ref: "7", executor: "李四" });
  });

  it("英文名与连字符", async () => {
    const { parseTaskIntent } = await import("./feishu-task-assistant.js");
    expect(parseTaskIntent("安排执行者 #3 @wang-wu")).toEqual({
      kind: "assign",
      ref: "3",
      executor: "wang-wu",
    });
  });

  it("缺执行者 → 不命中（落 help/兜底）", async () => {
    const { parseTaskIntent } = await import("./feishu-task-assistant.js");
    expect(parseTaskIntent("安排执行者 #12").kind).toBe("help");
  });

  it("不吞掉「确认派发 #N」", async () => {
    const { parseTaskIntent } = await import("./feishu-task-assistant.js");
    expect(parseTaskIntent("确认派发 #12")).toEqual({ kind: "dispatch-confirm", ref: "12" });
  });
});

// ── 澄清归属意图（任务归属 N @仓库 / 跳过任务 N） ──────────────────

describe("parseTaskIntent — 决策回复（耳朵）", () => {
  it("决策 R码/短码 序号或文字", () => {
    expect(parseTaskIntent("决策 R12 2")).toEqual({ kind: "decision", ref: "R12", option: "2" });
    expect(parseTaskIntent("决策 3fa660dd 修 Playground")).toEqual({
      kind: "decision",
      ref: "3fa660dd",
      option: "修 Playground",
    });
  });
  it("决策 带#与冒号变体", () => {
    expect(parseTaskIntent("决策 #R12 1")).toEqual({ kind: "decision", ref: "R12", option: "1" });
    expect(parseTaskIntent("决策：R12 方案A")).toEqual({ kind: "decision", ref: "R12", option: "方案A" });
  });
  it("决策 省略选项 = 采用缺省项", () => {
    expect(parseTaskIntent("决策 R12")).toEqual({ kind: "decision", ref: "R12", option: "" });
    expect(parseTaskIntent("决策 3fa660dd")).toEqual({ kind: "decision", ref: "3fa660dd", option: "" });
  });
  it("纯中文编号不误命中（普通语句落默认语义）", () => {
    expect(parseTaskIntent("决策很难做")).not.toEqual(expect.objectContaining({ kind: "decision" }));
    expect(parseTaskIntent("决策 很难做")).not.toEqual(expect.objectContaining({ kind: "decision" }));
  });
});

describe("parseTaskIntent — 澄清归属", () => {
  it("任务归属 N @短名 与 @组织/仓库 全名", () => {
    expect(parseTaskIntent("任务归属 3 @video")).toEqual({
      kind: "pending-assign",
      ref: "3",
      repo: "video",
    });
    expect(
      parseTaskIntent("任务归属 12 @AIGility-Cloud-Innovation/nx-telecom-video-platform"),
    ).toEqual({
      kind: "pending-assign",
      ref: "12",
      repo: "AIGility-Cloud-Innovation/nx-telecom-video-platform",
    });
  });

  it("带 # 与冒号变体、归属任务同义", () => {
    expect(parseTaskIntent("归属任务 #4：opc")).toEqual({
      kind: "pending-assign",
      ref: "4",
      repo: "opc",
    });
    expect(parseTaskIntent("任务归属 4, opc")).toEqual({
      kind: "pending-assign",
      ref: "4",
      repo: "opc",
    });
  });

  it("跳过任务 N（含 # 与语序变体）", () => {
    expect(parseTaskIntent("跳过任务 5")).toEqual({ kind: "pending-skip", ref: "5" });
    expect(parseTaskIntent("任务跳过 #5")).toEqual({ kind: "pending-skip", ref: "5" });
  });

  it("任务归属 N 项目简称（中文别名）→ pending-assign（解析在编排层）", () => {
    expect(parseTaskIntent("任务归属 1 太忆")).toEqual({
      kind: "pending-assign",
      ref: "1",
      repo: "太忆",
    });
    expect(parseTaskIntent("任务归属 2 nx-telecom")).toEqual({
      kind: "pending-assign",
      ref: "2",
      repo: "nx-telecom",
    });
  });

  it("确认 N → confirm-pending；不吞「确认派发 N」", () => {
    expect(parseTaskIntent("确认 1")).toEqual({ kind: "confirm-pending", ref: "1" });
    expect(parseTaskIntent("没问题 #2")).toEqual({ kind: "confirm-pending", ref: "2" });
    expect(parseTaskIntent("确认派发 1").kind).toBe("dispatch-confirm");
    expect(parseTaskIntent("确认了吗").kind).toBe("help");
  });

  it("多行核验合并：确认/归属/执行者/跳过 混合 → pending-batch", () => {
    expect(
      parseTaskIntent("确认 1\n任务归属 2 太忆\n安排执行者 3 hongbin\n跳过任务 4"),
    ).toEqual({
      kind: "pending-batch",
      items: [
        { action: "confirm", ref: "1" },
        { action: "assign", ref: "2", repo: "太忆" },
        { action: "assign-executor", ref: "3", executor: "hongbin" },
        { action: "skip", ref: "4" },
      ],
    });
  });

  it("邮箱等 @ 片段不误触；普通句子落 help", () => {
    expect(parseTaskIntent("任务归属 1 bob@example.com").kind).toBe("help");
    expect(parseTaskIntent("这个任务的归属问题回头再说").kind).toBe("help");
  });

  it("多行归属确认合并一条消息 → pending-batch（真实事故回归）", () => {
    expect(
      parseTaskIntent("任务归属 1 @TiMEM-Space\n任务归属 2 @TiMEM-Space"),
    ).toEqual({
      kind: "pending-batch",
      items: [
        { action: "assign", ref: "1", repo: "TiMEM-Space" },
        { action: "assign", ref: "2", repo: "TiMEM-Space" },
      ],
    });
  });

  it("多行混合归属与跳过 → pending-batch", () => {
    expect(parseTaskIntent("任务归属 1 @video\n跳过任务 2")).toEqual({
      kind: "pending-batch",
      items: [
        { action: "assign", ref: "1", repo: "video" },
        { action: "skip", ref: "2" },
      ],
    });
  });

  it("多行混入非归属内容 → 不按批处理（保持原语义）", () => {
    expect(parseTaskIntent("任务归属 1 @video\n你好").kind).toBe("help");
    expect(parseTaskIntent("任务归属 1 @video").kind).toBe("pending-assign");
  });
});

// ── 项目进展 / 反馈（委托 @orchestration/project-briefing） ──────────

describe("parseTaskIntent — 项目进展与反馈", () => {
  it("项目进展（无名称 / 带名称）", () => {
    expect(parseTaskIntent("项目进展")).toEqual({ kind: "project-status" });
    expect(parseTaskIntent("项目进展：timem")).toEqual({ kind: "project-status", project: "timem" });
    expect(parseTaskIntent("进展汇报 nx")).toEqual({ kind: "project-status", project: "nx" });
  });

  it("反馈（多种引导词与标点）", () => {
    expect(parseTaskIntent("反馈：周三例会改到上午")).toEqual({ kind: "feedback", text: "周三例会改到上午" });
    expect(parseTaskIntent("反馈 周三例会改到上午")).toEqual({ kind: "feedback", text: "周三例会改到上午" });
    expect(parseTaskIntent("意见反馈，界面不错")).toEqual({ kind: "feedback", text: "界面不错" });
    expect(parseTaskIntent("建议:把日报提前到九点")).toEqual({ kind: "feedback", text: "把日报提前到九点" });
  });

  it("裸「建议」不触发反馈（避免把任务建议误当反馈）", () => {
    expect(parseTaskIntent("建议加个导出功能").kind).toBe("help");
  });

  it("空反馈不触发", () => {
    expect(parseTaskIntent("反馈：").kind).toBe("help");
  });
});

// ── 无编号指令 / 一行多指令（引用摘要回复场景） ─────────────────────

describe("parseTaskIntent — 无编号与连写核验", () => {
  it("无编号单指令 → ref 空串（编排层用 root_id 反查）", () => {
    expect(parseTaskIntent("任务归属 TiMEM-AI/timem-platform-backend")).toEqual({
      kind: "pending-assign",
      ref: "",
      repo: "TiMEM-AI/timem-platform-backend",
    });
    expect(parseTaskIntent("安排执行者 徐彬程")).toEqual({
      kind: "assign",
      ref: "",
      executor: "徐彬程",
    });
    expect(parseTaskIntent("确认")).toEqual({ kind: "confirm-pending", ref: "" });
  });

  it("一行连写两条指令 → pending-batch（真实场景回归：徐彬程 事件）", () => {
    expect(
      parseTaskIntent("安排执行者 xubincheng 任务归属 TiMEM-AI/timem-platform-backend"),
    ).toEqual({
      kind: "pending-batch",
      items: [
        { action: "assign-executor", ref: "", executor: "xubincheng" },
        { action: "assign", ref: "", repo: "TiMEM-AI/timem-platform-backend" },
      ],
    });
  });

  it("带编号与无编号混写一行也能切分", () => {
    expect(parseTaskIntent("确认 #5 任务归属 太忆")).toEqual({
      kind: "pending-batch",
      items: [
        { action: "confirm", ref: "5" },
        { action: "assign", ref: "", repo: "太忆" },
      ],
    });
  });

  it("普通句子含「确认」不误切（保持原语义）", () => {
    expect(parseTaskIntent("我确认一下明天开会时间").kind).toBe("help");
  });
});

// ── 建单顺带指派：「… 安排给 徐彬程」→ 标题剥离 + executor ──────────

describe("parseTaskIntent — 建单顺带指派执行人", () => {
  it("建工单标题剥掉「安排给 X」并带 executor", () => {
    const intent = parseTaskIntent(
      "建工单 @timem-platform：账单导出功能需要修复 安排给徐彬程",
    );
    expect(intent.kind).toBe("issue-create");
    if (intent.kind === "issue-create") {
      expect(intent.title).toBe("账单导出功能需要修复");
      expect(intent.executor).toBe("徐彬程");
      expect(intent.repo).toBe("timem-platform");
    }
  });

  it("建任务同样支持（交给/让 变体）", () => {
    const intent = parseTaskIntent("建任务 @video：修白屏 交给 wang-wu");
    expect(intent.kind).toBe("create");
    if (intent.kind === "create") {
      expect(intent.title).toBe("修白屏");
      expect(intent.executor).toBe("wang-wu");
    }
  });

  it("普通聊天里的「让张三」不误触发（非建单开头）", () => {
    expect(parseTaskIntent("这个 bug 让张三看看吧").kind).toBe("help");
  });
});
