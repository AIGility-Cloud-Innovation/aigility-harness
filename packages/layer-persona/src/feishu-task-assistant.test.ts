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

  it("兜底模型默认 glm-5.3-flash、温度 0.2（可控性替换 qwen-turbo）", async () => {
    const ctx = mockCtx({
      "@cognitive/llm-inference": () => ({ ok: true, value: { text: "好的，可以聊聊" } }),
    });
    await feishuTaskAssistantProvider.execute({ user_input: "随便聊聊" }, ctx);
    const { req } = (ctx.calls as unknown[])[0] as { req: Record<string, unknown> };
    expect(req["model"]).toBe("glm-5.3-flash");
    expect(req["temperature"]).toBe(0.2);
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
