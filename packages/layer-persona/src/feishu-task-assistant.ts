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
 *   其他：能力说明（帮助文本）
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
  | { kind: "create"; title: string; dueDate?: string; repo?: string }
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
  | { kind: "overview" }
  | { kind: "help" };

/** 消费编排层项目小助理业务域（双建同步单一真相） */
export const taskIssueSyncRef: CapabilityRef = {
  id: "@orchestration/task-issue-sync",
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
  version: "1.2.0",
  layer: LayerId.Persona,
  description:
    "项目小助理：交互形象（正则意图解析 + 帮助文本），业务委托 @orchestration/task-issue-sync（双建同步）",
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
  return { text: text.replace(m[0], " ").replace(/\s{2,}/g, " ").trim(), repo: m[1] };
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
    // 首行为标题，其余行作为正文
    const lines = m[1].split(/\r?\n/);
    const title = lines[0].trim().replace(/^[:：，,]\s*/, "");
    const issueBody = lines.slice(1).join("\n").trim();
    if (title) {
      // 仓库必填：没带 @仓库 就反问（不静默落默认仓库）
      return repoSpec
        ? { kind: "issue-create", repo: repoSpec, title, body: issueBody || undefined }
        : { kind: "issue-need-repo", title, body: issueBody || undefined };
    }
  }

  // ── 飞书任务（C 方案：建任务也要求 @仓库，双向同步建工单） ──
  const taskStripped = extractRepoSpec(text);
  m = taskStripped.text.match(/^(?:建任务|创建任务|新建任务|添加任务)[:：，,]?\s*(.+)$/);
  if (m) {
    let title = m[1].trim().replace(/^[:：，,]\s*/, "");
    let dueDate: string | undefined;
    const due = title.match(DUE_RE);
    if (due) {
      dueDate = due[1];
      title = title.slice(0, due.index).trim();
    }
    if (title) {
      // 带 @仓库 → 双建；缺 @仓库 → 反问（不写任何数据）
      return taskStripped.repo
        ? { kind: "create", title, dueDate, repo: taskStripped.repo }
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

例：「建任务 @video：修复登录页白屏 截止 2026-10-16」（飞书任务 + 工单双建）
　　「建工单 @video：优化查询速度」（工单 + 飞书任务双建）`;

// ── Provider 实现：解析 → 委托编排层 → 回复信封 ──────────────────

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
      response = HELP_TEXT;
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
    "角色人格层：「项目小助理」交互形象（意图解析+帮助），业务下沉 @orchestration/task-issue-sync（任务/工单双建同步）",
  version: "1.2.0",
  provides: [feishuTaskAssistantService],
  consumes: [taskIssueSyncRef],
  preferredCarrier: CarrierKind.Thread,
};
