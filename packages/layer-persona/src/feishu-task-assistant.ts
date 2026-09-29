/**
 * L3 角色人格层: feishu-task-assistant —「项目小助理」交互形象
 *
 * ③ 架构收法（2026-09-26 拍板）：persona 只留脸——正则意图解析、帮助文本、
 * 回复信封；飞书任务/Gitea 工单的全部业务处理下沉编排层
 * @orchestration/task-issue-sync（单一真相，task-pipeline 被动流水线共用）。
 *
 * 双建同步（C 方案，业务在编排层）：
 *   建工单 @仓库 → Gitea 单 + 飞书任务（挂 org 清单，缺清单自动创建）
 *   建任务 @仓库 → 飞书任务 + Gitea 单（对称；缺 @仓库 反问不写数据）
 *
 * 意图解析采用确定性正则（零 LLM 成本、零幻觉、可单测），「任务」与「工单」
 * 触发词严格区分，工单意图先于任务意图匹配（避免「完成工单 x」被「完成 x」吞掉）：
 *   飞书：建任务 [@仓库]：<标题> [截止 YYYY-MM-DD] | 我的任务 | 完成 <关键字>
 *   工单：建工单 @组织/仓库：<标题>（多行正文，自动查重；仓库必填，
 *         缺省不落默认仓库而是反问并列出可访问仓库）| 工单列表 [@仓库]
 *         | 查工单 [@仓库] <#n|关键字> | 关闭工单/重开工单 [@仓库] <#n|关键字>
 *         | 评论工单 [@仓库] <#n> <内容>
 *   协调：项目概览 —— 飞书待办 + 进行中工单一屏汇总
 *   其他：LLM 自然语言兜底回复（TASK_ASSISTANT_LLM_FALLBACK=0 关闭；失败回退帮助文本；输出过防编造过滤）
 */

import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

/**
 * 意图类型（persona=解析产出方，编排层=消费方）：
 * 与 @orchestration/task-issue-sync 的 TaskIntent 结构化对齐，
 * 不跨包 import（层间解耦惯例，运行时仅 JSON 透传）——两侧字段须同步改。
 */
export type TaskIntent =
  | { kind: "create"; title: string; dueDate?: string; repo?: string; description?: string }
  | { kind: "list" }
  | { kind: "complete"; keyword: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string }
  | { kind: "issue-list"; repo?: string }
  | { kind: "issue-show"; repo?: string; ref: string }
  | { kind: "issue-close"; repo?: string; ref: string }
  | { kind: "issue-reopen"; repo?: string; ref: string }
  | { kind: "issue-comment"; repo?: string; ref: string; comment: string }
  /** 建工单未指定仓库：反问并列出可访问仓库（不发任何写请求） */
  | { kind: "issue-need-repo"; title: string; body?: string }
  /** 建任务未指定仓库（C 方案要求同步建工单）：反问，不写任何数据 */
  | { kind: "task-need-repo"; title: string; dueDate?: string }
  /** 派发确认：「确认派发 #N」（闸门内提前执行） */
  | { kind: "dispatch-confirm"; ref: string }
  /** 派发取消：「取消派发 #N」（撤销 agentd 任务） */
  | { kind: "dispatch-cancel"; ref: string }
  /** 安排执行者：「安排执行者 #N @张三」（P→D 前置条件） */
  | { kind: "assign"; ref: string; executor: string }
  /** 澄清归属确认：「任务归属 N @仓库」（把群内澄清队列的候选建成工单） */
  | { kind: "pending-assign"; ref: string; repo: string }
  /** 澄清归属放弃：「跳过任务 N」（丢弃澄清队列候选，不建单） */
  | { kind: "pending-skip"; ref: string }
  | { kind: "overview" }
  | { kind: "help" };

/** 消费编排层项目小助理业务域（双建同步单一真相） */
export const taskIssueSyncRef: CapabilityRef = {
  id: "@orchestration/task-issue-sync",
  versionRange: "^1.0.0",
};

/** 消费认知层 LLM 推理（正则未命中时的自然语言兜底回复） */
export const llmInferenceRefForPersona: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface FeishuTaskAssistantRequest {
  /** 用户消息原文 */
  user_input: string;
  /** 用户标识（飞书 open_id） */
  user_id?: string;
  /** 会话 ID（飞书 chat_id） */
  session_id?: string;
  /** 聊天类型: p2p | group */
  chat_type?: string;
}

export interface FeishuTaskAssistantResponse {
  /** 回复文本（ingress 原地编辑到占位消息） */
  response: string;
  agent_name: string;
  session_id: string;
  trace_id: string;
}

export const feishuTaskAssistantService: ServiceDefinition<
  FeishuTaskAssistantRequest,
  FeishuTaskAssistantResponse
> = {
  id: "@persona/feishu-task-assistant",
  version: "1.4.0",
  layer: LayerId.Persona,
  description:
    "项目小助理：交互形象（正则意图解析 + LLM 兜底回复），业务委托 @orchestration/task-issue-sync（双建同步）",
};

// ── 意图解析（导出供单测；类型/语义与编排层 TaskIntent 对齐） ─────

/**
 * 提取消息内的仓库指定片段 @组织/仓库 或 @短名：
 *   - 显式：@AIGility-Cloud-Innovation/nx-telecom-video-platform
 *   - 简写：@video → 编排层 resolveRepoInput 在可访问仓库里模糊解析
 * 负向前瞻 (?![.\w]) 防邮箱误触：bob@example.com 的 @example 后跟点不匹配，
 * 而「建工单@video：标题」「（@video）」等紧贴场景可正常识别
 */
export function extractRepoSpec(text: string): { text: string; repo?: string } {
  const m = text.match(/\s*@([A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)?)(?![.\w@])/);
  if (!m) return { text };
  // 只压横向空白（[^\S\n]）：多行正文结构保留——建任务/建工单「触发词独占一行、
  // 标题在下一行」的拆分依赖换行（#1234 事故消息正是该形态）；横向多空格仍归一
  return { text: text.replace(m[0], " ").replace(/[^\S\n]{2,}/g, " ").trim(), repo: m[1] };
}

const DUE_RE = /\s*截止[:：]?\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** 工单意图解析（文本已剥离 @仓库 片段与触发词，仓库必填性在此分派） */
function issueIntentFrom(
  kind: "issue-list" | "issue-show" | "issue-close" | "issue-reopen" | "issue-comment",
  rest: { repo?: string; ref?: string; comment?: string },
): TaskIntent {
  switch (kind) {
    case "issue-list":
      return { kind, repo: rest.repo };
    case "issue-show":
    case "issue-close":
    case "issue-reopen":
      return { kind, repo: rest.repo, ref: rest.ref ?? "" };
    case "issue-comment":
      return { kind, repo: rest.repo, ref: rest.ref ?? "", comment: rest.comment ?? "" };
  }
}

/** 把用户消息解析为协调意图（工单意图先于任务意图，触发词含「工单」优先） */
export function parseTaskIntent(input: string): TaskIntent {
  const text = input.trim();

  // ── 协调：项目概览 ──
  if (/^(?:项目概览|项目状态|整体概览|概览)$/.test(text)) {
    return { kind: "overview" };
  }

  // ── Gitea 工单（先剥离 @仓库 片段再匹配触发词） ──
  // 注意：安排执行者的 @姓名 必须在剥离前用原始文本匹配，
  // 否则 extractRepoSpec 会把 @张三/@wang-wu 当 @仓库 片段吃掉
  const am = text.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*#?(\d+)\s+@?([\p{Script=Han}\w·\-]{1,32})\s*$/u);
  if (am) return { kind: "assign", ref: am[1], executor: am[2] };

  // ── 澄清归属（原始文本匹配，@仓库 不能被 extractRepoSpec 提前吃掉） ──
  // 触发：被动汇总判不动仓库归属时，群里会收到带编号的澄清问询
  const pa = text.match(/^(?:任务归属|归属任务)\s*[:：]?\s*#?(\d+)(?:\s|[:：,，])+\s*@?([A-Za-z0-9._/-]{1,80})\s*$/u);
  if (pa) return { kind: "pending-assign", ref: pa[1], repo: pa[2] };
  const ps = text.match(/^(?:跳过任务|任务跳过)\s*[:：]?\s*#?(\d+)\s*$/u);
  if (ps) return { kind: "pending-skip", ref: ps[1] };

  const stripped = extractRepoSpec(text);
  const repoSpec = stripped.repo;
  const body = stripped.text;

  // ── 派发确认/取消（闸门交互；「取消派发 #N」「确认派发 #N」） ──
  let dm = body.match(/^(?:确认派发|立即执行|马上执行)\s*[:：]?\s*#?(\d+)\s*$/);
  if (dm) return { kind: "dispatch-confirm", ref: dm[1] };
  dm = body.match(/^(?:取消派发|别派发|撤销派发)\s*[:：]?\s*#?(\d+)\s*$/);
  if (dm) return { kind: "dispatch-cancel", ref: dm[1] };

  if (/^(?:工单列表|我的工单|列出工单|看看工单|查工单列表)$/.test(body)) {
    return issueIntentFrom("issue-list", { repo: repoSpec });
  }

  let m = body.match(/^(?:评论工单|回复工单)\s*[:：]?\s*#?(\d+)\s*[:：,，]?\s*([\s\S]+)$/);
  if (m) {
    return issueIntentFrom("issue-comment", {
      repo: repoSpec,
      ref: m[1],
      comment: m[2].trim(),
    });
  }

  m = body.match(/^(?:查工单|看工单|工单详情)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-show", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:关闭工单|完结工单|完成工单|关掉工单|关单)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-close", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:重开工单|重新打开工单)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return issueIntentFrom("issue-reopen", { repo: repoSpec, ref: m[1].trim() });
  }

  m = body.match(/^(?:建工单|创建工单|新建工单|开个工单)[:：，,]?\s*([\s\S]+)$/);
  if (m) {
    // 首个非空行为标题，其余行作为正文（触发词独占一行时标题在下一行）
    const lines = m[1].split(/\r?\n/);
    let ti = 0;
    while (ti < lines.length && !lines[ti].trim()) ti++;
    const title = (lines[ti] ?? "").trim().replace(/^[:：，,]\s*/, "");
    const issueBody = lines.slice(ti + 1).join("\n").trim();
    if (title) {
      // 仓库必填：没带 @仓库 就反问（不静默落默认仓库）
      return repoSpec
        ? { kind: "issue-create", repo: repoSpec, title, body: issueBody || undefined }
        : { kind: "issue-need-repo", title, body: issueBody || undefined };
    }
  }

  // ── 飞书任务（C 方案：建任务也要求 @仓库，双向同步建工单） ──
  // 多行正文可解析（带图/带描述消息）：首个非空行为标题（触发词独占一行时标题
  // 在下一行，如「建任务：@仓库」剥掉 @仓库 后首行为空）、其余为描述
  const taskStripped = extractRepoSpec(text);
  m = taskStripped.text.match(/^(?:建任务|创建任务|新建任务|添加任务)[:：，,]?\s*([\s\S]+)$/);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    let titleIdx = 0;
    while (titleIdx < lines.length && !lines[titleIdx].trim()) titleIdx++;
    let title = (lines[titleIdx] ?? "").trim().replace(/^[:：，,]\s*/, "");
    let dueDate: string | undefined;
    const due = title.match(DUE_RE);
    if (due) {
      dueDate = due[1];
      title = title.slice(0, due.index).trim();
    }
    const description = lines.slice(titleIdx + 1).join("\n").trim();
    if (title) {
      // 带 @仓库 → 双建；缺 @仓库 → 反问（不写任何数据；用户带 @仓库 重发后全量重新解析）
      return taskStripped.repo
        ? { kind: "create", title, dueDate, repo: taskStripped.repo, description: description || undefined }
        : { kind: "task-need-repo", title, dueDate };
    }
  }

  if (/^(我的任务|任务列表|列出任务|查任务|看看任务)/.test(text)) {
    return { kind: "list" };
  }

  m = text.match(/^(?:完成任务|完成了|做完|完结|完成)\s*[:：]?\s*(.+)$/);
  if (m && m[1].trim()) {
    return { kind: "complete", keyword: m[1].trim() };
  }

  return { kind: "help" };
}

// ── 帮助文本 ─────────────────────────────────────────────────────

const AGENT_NAME = "项目小助理";

const HELP_TEXT = `我是「项目小助理」，负责协调你的飞书任务和 Gitea 工单（git.aigility.cloud；只管理，不执行具体工作）。

📋 飞书任务 ⇄ 🎫 Gitea 工单 双向同步（建一侧自动建另一侧）
• 建任务 @仓库：<标题>（可加"截止 YYYY-MM-DD"）
• 建工单 @仓库：<标题>（可多行，首行为标题其余为正文；自动查重）
• @仓库：@组织/仓库 或 @仓库短名（如 @video）

🔍 查询/操作
• 我的任务 —— 查看待办任务
• 完成 <关键字> —— 完结匹配的飞书任务
• 工单列表 [@仓库] / 查工单 [@仓库] <#编号或关键字>
• 关闭工单 [@仓库] <#编号或关键字> / 重开工单 [@仓库] <#编号>
• 评论工单 [@仓库] <#编号> <内容>

📊 项目概览 —— 飞书待办 + 进行中工单一屏汇总

👤 执行者安排 —— 「安排执行者 #工单号 @姓名」
安排好执行者的任务才会进入执行队列（P → D）

🧾 归属澄清 —— 自动汇总拿不准仓库归属时，会在群里列编号请本群确认
• 任务归属 <编号> @仓库 —— 确认归属并建工单
• 跳过任务 <编号> —— 丢弃该条，不建单

例：「建任务 @video：修复登录页白屏 截止 2026-10-16」（飞书任务 + 工单双建）
　　「建工单 @video：优化查询速度」（工单 + 飞书任务双建）
　　「安排执行者 #12 @张三」（指定执行者，任务才会开始流转执行）`;

// ── Provider 实现：解析 → 委托编排层 → 回复信封 ──────────────────

/** 正则未命中时是否走 LLM 兜底（TASK_ASSISTANT_LLM_FALLBACK=0 关闭，回退帮助文本） */
function llmFallbackEnabled(): boolean {
  return process.env.TASK_ASSISTANT_LLM_FALLBACK !== "0";
}

/** 兜底回复模型（可 env 覆盖；默认 glm-5.3-flash——可控性优于 qwen-turbo，
 * 后者在禁编造约束下仍编出 #1234 工单号，已弃用） */
function fallbackModel(): string {
  return process.env.TASK_ASSISTANT_MODEL ?? "glm-5.3-flash";
}

/**
 * 兜底防编造后置过滤（导出供单测）：兜底能力没有任何工具，不可能执行过任何
 * 操作——回复中出现「已/刚刚/为您…创建/完成/…」或具体编号（#\d+）即构造性为假
 * （#1234 事件：prompt 明令禁止仍被无视）。命中即整条丢弃，把「不编造操作」
 * 从模型自觉变成代码保证。误伤的最坏后果是回退帮助文本，方向安全。
 */
export function isFabricatedReply(text: string): boolean {
  return /#\d+|(?:已(?!知)|刚刚|为您|帮你|帮您)[^。；！？\n]{0,12}(?:创建|建立|建好|建了|建|执行|完成|处理|派发|关闭|重开|评论|更新)/.test(
    text,
  );
}

/**
 * LLM 兜底回复：正则意图未命中时，以「项目小助理」身份生成自然回复。
 * 输出过防编造过滤（isFabricatedReply），失败/关闭时回退帮助文本（不比改动前差）。
 */
async function generateFallbackReply(
  userText: string,
  ctx: SeamContext,
): Promise<string> {
  if (!llmFallbackEnabled()) return HELP_TEXT;
  try {
    const r = (await ctx.call(llmInferenceRefForPersona, {
      model: fallbackModel(),
      messages: [
        {
          role: "system",
          content:
            "你是飞书群里的「项目小助理」，负责管理飞书任务与 Gitea 工单（git.aigility.cloud）：建任务/工单（须 @仓库）、查列表、关闭/重开/评论、项目概览、任务派发确认（「确认派发 #N」/「取消派发 #N」）。" +
            "用户的消息没有命中任何指令格式。请用友好简洁的中文自然回复（2-4 句）：能帮上忙就直接回应；与任务/工单无关时礼貌说明职责并给出最接近的可用指令示例；闲聊不过度展开。" +
            "你没有连接任何系统、没有任何工具，永远不可能替用户执行操作：严禁声称已创建/已执行/已完成任何任务或工单，严禁给出具体的任务或工单编号；不确定时引导用户用指令表达。不要输出 markdown 标题或代码块。",
        },
        { role: "user", content: userText },
      ],
      temperature: 0.2,
      max_tokens: 500,
      userId: "feishu-task-assistant-fallback",
    })) as { ok: boolean; value?: { text?: string }; error?: string };
    const text = r.ok ? (r.value?.text ?? "").trim() : "";
    if (text) {
      if (isFabricatedReply(text)) {
        console.error(
          `[feishu-task-assistant] LLM 兜底疑似编造操作（防编造过滤命中），回退帮助文本: ${text.slice(0, 120)}`,
        );
        return HELP_TEXT;
      }
      return text;
    }
    console.error(
      `[feishu-task-assistant] LLM 兜底失败，回退帮助文本: ${r.error ?? "空响应"}`,
    );
  } catch (e) {
    console.error(`[feishu-task-assistant] LLM 兜底异常，回退帮助文本: ${String(e)}`);
  }
  return HELP_TEXT;
}

export const feishuTaskAssistantProvider: Provider<
  FeishuTaskAssistantRequest,
  FeishuTaskAssistantResponse
> = {
  service: feishuTaskAssistantService,
  name: "persona-feishu-task-assistant",
  state: PluginState.Active,

  async execute(
    request: FeishuTaskAssistantRequest,
    ctx: SeamContext,
  ): Promise<Result<FeishuTaskAssistantResponse>> {
    const intent = parseTaskIntent(request.user_input ?? "");
    let response: string;

    if (intent.kind === "help") {
      // 正则未命中（含显式问「帮助」，均落 help 意图）：LLM 自然语言兜底
      // （输出过防编造过滤，失败/关闭回退帮助文本）
      response = await generateFallbackReply(request.user_input ?? "", ctx);
    } else {
      // 业务全部委托编排层（含概览；need-repo 反问也在编排层做——
      // 需要实时拉可访问仓库列表）
      const r = (await ctx.call(
        taskIssueSyncRef,
        { mode: "intent", intent, session_id: request.session_id },
      )) as { ok: boolean; value?: { response?: string }; error?: string };
      response =
        r.ok && r.value?.response
          ? r.value.response
          : `❌ 业务处理失败：${r.error ?? "编排层无响应"}`;
    }

    return ok({
      response,
      agent_name: AGENT_NAME,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },

  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "feishu-task-assistant ready（解析+信封，业务→ @orchestration/task-issue-sync）",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/feishu-task-assistant",
  layer: LayerId.Persona,
  description:
    "角色人格层：「项目小助理」交互形象（意图解析+帮助+兜底防编造过滤），业务下沉 @orchestration/task-issue-sync（任务/工单双建同步）",
  version: "1.4.0",
  provides: [feishuTaskAssistantService],
  consumes: [taskIssueSyncRef, llmInferenceRefForPersona],
  preferredCarrier: CarrierKind.Thread,
};
