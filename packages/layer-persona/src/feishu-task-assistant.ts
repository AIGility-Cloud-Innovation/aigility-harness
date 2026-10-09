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
 *   汇总（@orchestration/project-briefing）：我的任务=人视角全景（工单/PR/任务/记忆）
 *         | 项目进展 [名称] —— 项目四源进展 | 反馈：<内容> —— 沉淀进 timem
 *   其他：LLM 自然语言兜底回复（TASK_ASSISTANT_LLM_FALLBACK=0 关闭；失败回退帮助文本；输出过防编造过滤）
 *
 * RSI 递归自我改进（2026-10-07 接入，「小助理太笨」治理）：
 *   读半边——兜底回复前经 @action/timem-rule-recall + @action/timem-memory 召回
 *   经验规则与相关记忆注入系统提示词（召回失败/超时静默降级，绝不阻断回复）；
 *   写半边——兜底对话轮 (问, 答) 异步沉淀 @action/timem-memory-write，供后续召回；
 *   「反馈：以后…」在原记忆沉淀外追加 @action/timem-rule-create 固化为经验规则。
 *   闭环：答错→用户纠正→成规则→下次召回→不再错。
 *
 * 短时记忆（2026-10-07 接入，「缺少短时记忆」治理）：per-chat 滚动窗口记录最近
 * 16 轮对话（TTL 2h，纯内存），兜底回复时注入 messages——单轮兜底从此能接住
 * 「刚才说的」。TASK_ASSISTANT_CONTEXT=0 关闭。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  | { kind: "create"; title: string; dueDate?: string; repo?: string; description?: string; executor?: string }
  | { kind: "list" }
  | { kind: "complete"; keyword: string }
  | { kind: "issue-create"; repo: string; title: string; body?: string; executor?: string }
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
  /** 澄清归属确认：「任务归属 N 仓库/项目简称」（摘要核验/澄清队列落单；简称经项目登记表解析） */
  | { kind: "pending-assign"; ref: string; repo: string }
  /** 澄清归属放弃：「跳过任务 N」（丢弃澄清队列候选，不建单） */
  | { kind: "pending-skip"; ref: string }
  /** 摘要核验确认：「确认 N」——认可 LLM 判断（项目/执行人齐备即记录） */
  | { kind: "confirm-pending"; ref: string }
  /** 多行澄清归属：一条消息里逐行「任务归属 N 仓库 / 安排执行者 N 姓名 / 确认 N / 跳过任务 N」
   *  （用户习惯把多条确认合并在一条消息发送，单行正则整串锚定匹配不到） */
  | {
      kind: "pending-batch";
      items: Array<
        | { action: "assign"; ref: string; repo: string }
        | { action: "skip"; ref: string }
        | { action: "confirm"; ref: string }
        | { action: "assign-executor"; ref: string; executor: string }
      >;
    }
  | { kind: "overview" }
  | { kind: "help" }
  /** 项目进展：多源汇总某项目（飞书/任务清单/Gitea/运维日志/timem）——走 @orchestration/project-briefing */
  | { kind: "project-status"; project?: string }
  /** 反馈写入：用户给小助理的反馈沉淀进 timem——走 @orchestration/project-briefing */
  | { kind: "feedback"; text: string };

/** 消费编排层项目小助理业务域（双建同步单一真相） */
export const taskIssueSyncRef: CapabilityRef = {
  id: "@orchestration/task-issue-sync",
  versionRange: "^1.0.0",
};

/** 消费编排层多源汇总（我的任务/项目进展/反馈写入） */
export const projectBriefingRef: CapabilityRef = {
  id: "@orchestration/project-briefing",
  versionRange: "^1.0.0",
};

/** 消费认知层 LLM 推理（正则未命中时的自然语言兜底回复） */
export const llmInferenceRefForPersona: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};

/** 消费行动层 TiMEM 记忆检索（RSI 读半边：兜底前召回相关记忆） */
export const timemMemoryRefForAssistant: CapabilityRef = {
  id: "@action/timem-memory",
  versionRange: "^1.0.0",
};

/** 消费行动层 TiMEM 记忆写入（RSI 写半边：兜底对话轮沉淀） */
export const timemMemoryWriteRefForAssistant: CapabilityRef = {
  id: "@action/timem-memory-write",
  versionRange: "^1.0.0",
};

/** 消费行动层 TiMEM 经验规则召回（RSI 读半边：兜底前召回可复用经验） */
export const timemRuleRecallRefForAssistant: CapabilityRef = {
  id: "@action/timem-rule-recall",
  versionRange: "^1.0.0",
};

/** 消费行动层 TiMEM 经验规则沉淀（「反馈：以后…」固化为规则） */
export const timemRuleCreateRefForAssistant: CapabilityRef = {
  id: "@action/timem-rule-create",
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
  /** 群聊中是否 @了机器人；免@群消息走「仅指令」模式（未命中意图保持静默，不兜底不帮助） */
  mentioned_bot?: boolean;
  /** 引用回复的消息 id（引用摘要回复时可省略条目编号，由编排层反查） */
  root_id?: string;
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
  version: "1.5.0",
  layer: LayerId.Persona,
  description:
    "项目小助理：交互形象（正则意图解析 + LLM 兜底回复），任务/工单业务委托 @orchestration/task-issue-sync（双建同步），我的任务/项目进展/反馈委托 @orchestration/project-briefing（多源汇总）",
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

  // 建单时顺带指派执行人：「建工单 @仓库：标题 安排给 徐彬程」→ 标题剥掉后缀。
  // 仅当整句以建任务/建工单开头才尝试，避免普通聊天里「…让张三」误触发。
  const em = text.match(/(?:^|\s)(?:安排给|交给|派给|指派给|让)\s*@?([\p{Script=Han}\w·\-]{1,32})\s*$/u);
  if (em && /^(?:建任务|创建任务|建工单|创建工单)/.test(text)) {
    const intent = parseTaskIntent(text.slice(0, em.index).trim());
    if (intent.kind === "create" || intent.kind === "issue-create") {
      return { ...intent, executor: em[1] };
    }
    return intent;
  }

  // ── 协调：项目概览 ──
  if (/^(?:项目概览|项目状态|整体概览|概览)$/.test(text)) {
    return { kind: "overview" };
  }

  // ── Gitea 工单（先剥离 @仓库 片段再匹配触发词） ──
  // 注意：安排执行者的 @姓名 必须在剥离前用原始文本匹配，
  // 否则 extractRepoSpec 会把 @张三/@wang-wu 当 @仓库 片段吃掉
  const am = text.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*#?(\d+)\s+@?([\p{Script=Han}\w·\-]{1,32})\s*$/u);
  if (am) return { kind: "assign", ref: am[1], executor: am[2] };

  // ── 澄清归属（原始文本匹配，@仓库/项目简称 不能被 extractRepoSpec 提前吃掉） ──
  // 触发：摘要核验与被动澄清问询。仓库支持 组织/仓库 全名或项目简称（如 太忆/nx），
  // 简称的登记表解析在编排层（resolveRepoOrAsk），这里只放宽词表
  const pa = text.match(/^(?:任务归属|归属任务)\s*[:：]?\s*#?(\d+)(?:\s|[:：,，])+\s*@?([\p{Script=Han}\w·\-/]{1,80})\s*$/u);
  if (pa) return { kind: "pending-assign", ref: pa[1], repo: pa[2] };
  const ps = text.match(/^(?:跳过任务|任务跳过)\s*[:：]?\s*#?(\d+)\s*$/u);
  if (ps) return { kind: "pending-skip", ref: ps[1] };
  // 摘要核验确认（「确认 1」；「确认派发 #N」是另一意图，带「派发」二字不会命中这里）
  const pc = text.match(/^(?:确认|确认任务|没问题)\s*[:：]?\s*#?(\d+)\s*$/u);
  if (pc) return { kind: "confirm-pending", ref: pc[1] };

  // ── 多行核验（同一消息逐行 确认/归属/执行者/跳过多条候选） ──
  // 单行正则整串锚定，用户把多条回复合并成一条消息（逐行发送）时整串解析
  // 失败会落 help——核验闭环就断在这里（真实事故：两行「任务归属 N @仓库」
  // 回成整段帮助文本，工单未建）。所有非空行都能解析为核验动作时按批处理，
  // 混有其他内容则保持原语义落后续分支。
  {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const items: Extract<TaskIntent, { kind: "pending-batch" }>["items"] = [];
      for (const line of lines) {
        const a = line.match(/^(?:任务归属|归属任务)\s*[:：]?\s*#?(\d+)(?:\s|[:：,，])+\s*@?([\p{Script=Han}\w·\-/]{1,80})\s*$/u);
        if (a) {
          items.push({ action: "assign", ref: a[1], repo: a[2] });
          continue;
        }
        const s = line.match(/^(?:跳过任务|任务跳过)\s*[:：]?\s*#?(\d+)\s*$/u);
        if (s) {
          items.push({ action: "skip", ref: s[1] });
          continue;
        }
        const c = line.match(/^(?:确认|确认任务|没问题)\s*[:：]?\s*#?(\d+)\s*$/u);
        if (c) {
          items.push({ action: "confirm", ref: c[1] });
          continue;
        }
        const e = line.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*#?(\d+)\s+@?([\p{Script=Han}\w·\-]{1,32})\s*$/u);
        if (e) {
          items.push({ action: "assign-executor", ref: e[1], executor: e[2] });
          continue;
        }
        items.length = 0;
        break;
      }
      if (items.length >= 2) return { kind: "pending-batch", items };
    }
  }

  // ── 无编号指令 / 一行多指令（引用摘要回复时用户常省略编号、把多条连写） ──
  // 编号缺省时意图带 ref=""，编排层用 root_id（被引用的摘要）反查条目；
  // 反查不到会反问而不是落帮助文本。
  {
    // 无编号单指令（整串锚定）
    const amN = text.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*@?([\p{Script=Han}\w·\-]{1,32})$/u);
    if (amN) return { kind: "assign", ref: "", executor: amN[1] };
    const paN = text.match(/^(?:任务归属|归属任务)\s*[:：]?\s*@?([\p{Script=Han}\w·\-/]{1,80})$/u);
    if (paN) return { kind: "pending-assign", ref: "", repo: paN[1] };
    if (/^(?:确认|没问题)$/.test(text)) return { kind: "confirm-pending", ref: "" };
    if (/^(?:跳过任务|任务跳过)$/.test(text)) return { kind: "pending-skip", ref: "" };

    // 一行多指令：按核验指令关键词切分，逐段按单指令解析；全部命中才按批处理
    const chunks = text
      .split(/(?=任务归属|归属任务|安排执行者|指派执行者|跳过任务|任务跳过|确认(?!派发)|没问题)/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (chunks.length >= 2) {
      const items: Extract<TaskIntent, { kind: "pending-batch" }>["items"] = [];
      for (const chunk of chunks) {
        const a = chunk.match(/^(?:任务归属|归属任务)\s*[:：]?\s*#?(\d+)(?:\s|[:：,，])+\s*@?([\p{Script=Han}\w·\-/]{1,80})$/u)
          ?? chunk.match(/^(?:任务归属|归属任务)\s*[:：]?\s*@?([\p{Script=Han}\w·\-/]{1,80})$/u);
        if (a) {
          items.push(
            a.length === 3
              ? { action: "assign", ref: a[1], repo: a[2] }
              : { action: "assign", ref: "", repo: a[1] },
          );
          continue;
        }
        const e = chunk.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*#?(\d+)\s+@?([\p{Script=Han}\w·\-]{1,32})$/u)
          ?? chunk.match(/^(?:安排执行者|指派执行者|安排|指派)\s*[:：]?\s*@?([\p{Script=Han}\w·\-]{1,32})$/u);
        if (e) {
          items.push(
            e.length === 3
              ? { action: "assign-executor", ref: e[1], executor: e[2] }
              : { action: "assign-executor", ref: "", executor: e[1] },
          );
          continue;
        }
        const c = chunk.match(/^(?:确认|没问题)\s*[:：]?\s*#?(\d+)?$/u);
        if (c) {
          items.push({ action: "confirm", ref: c[1] ?? "" });
          continue;
        }
        const sk = chunk.match(/^(?:跳过任务|任务跳过)\s*[:：]?\s*#?(\d+)?$/u);
        if (sk) {
          items.push({ action: "skip", ref: sk[1] ?? "" });
          continue;
        }
        items.length = 0;
        break;
      }
      if (items.length >= 2) return { kind: "pending-batch", items };
    }
  }

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

  if (/^(我的任务|我的安排|任务安排|工作安排|最近做什么|我在做什么|任务列表|列出任务|查任务|看看任务)/.test(text)) {
    return { kind: "list" };
  }

  // ── 项目进展（多源汇总，委托 @orchestration/project-briefing） ──
  m = text.match(/^(?:项目进展|进展汇报?)\s*[:：]?\s*(.*)$/);
  if (m) {
    const project = m[1].trim();
    return project ? { kind: "project-status", project } : { kind: "project-status" };
  }

  // ── 反馈写入（沉淀进 timem，委托 @orchestration/project-briefing） ──
  // 先整体匹配再剥引导标点：[\s\S]+ 会经回溯把冒号本身当内容，必须在代码里二次清洗
  m = text.match(/^(?:反馈|意见反馈|提个反馈)\s*[:：,，]?\s*([\s\S]+)$/);
  if (m) {
    const t = m[1].trim().replace(/^[:：,，]\s*/, "");
    if (t) return { kind: "feedback", text: t };
  }
  m = text.match(/^建议[:：]\s*([\s\S]+)$/);
  if (m && m[1].trim()) {
    return { kind: "feedback", text: m[1].trim() };
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
• 我的任务 —— 你的任务安排全景（待办工单 + 我的 PR + 飞书任务 + 相关记忆）
• 完成 <关键字> —— 完结匹配的飞书任务
• 工单列表 [@仓库] / 查工单 [@仓库] <#编号或关键字>
• 关闭工单 [@仓库] <#编号或关键字> / 重开工单 [@仓库] <#编号>
• 评论工单 [@仓库] <#编号> <内容>

📊 项目概览 —— 飞书待办 + 进行中工单一屏汇总
📈 项目进展 [名称] —— 项目横跨飞书/任务清单/Gitea/运维日志的进展

💬 反馈：<想说的> —— 记进你的长期记忆，作为以后安排任务的参考

👤 执行者安排 —— 「安排执行者 #工单号 @姓名」
安排好执行者的任务才会进入执行队列（P → D）

🧾 归属澄清 —— 自动汇总拿不准仓库归属时，会在群里列编号请本群确认
• 任务归属 <编号> 仓库/项目简称 —— 确认归属（简称如 太忆/nx/电信平台）
• 安排执行者 <编号> 姓名 —— 记录执行人（别名如 hongbin/宏斌）
• 确认 <编号> —— 认可摘要的判断（项目+执行人齐备即记录）
• 跳过任务 <编号> —— 丢弃该条，不建单
以上指令可多行合并在一条消息里逐条发送

例：「建任务 @video：修复登录页白屏 截止 2026-10-16」（飞书任务 + 工单双建）
　　「我的任务」（跨来源看自己的安排）
　　「反馈：周三例会改到上午十点」（记进长期记忆）`;

// ── Provider 实现：解析 → 委托编排层 → 回复信封 ──────────────────

/** 正则未命中时是否走 LLM 兜底（TASK_ASSISTANT_LLM_FALLBACK=0 关闭，回退帮助文本） */
function llmFallbackEnabled(): boolean {
  return process.env.TASK_ASSISTANT_LLM_FALLBACK !== "0";
}

/** 兜底回复模型（可 env 覆盖；2026-10-07 起 .env 显式配 deepseek-v4-flash——LiteLLM
 *  别名，实路由 glm-5.3-flash 推理模型。历史教训修正：所谓「部分输入返回空响应」
 *  的根因是推理 tokens 耗尽 max_tokens（finish_reason=length，正文 0 token），
 *  配套把兜底 max_tokens 提到 1500 后实测稳定；qwen-turbo 仍可作备选） */
function fallbackModel(): string {
  return process.env.TASK_ASSISTANT_MODEL ?? "deepseek-v4-flash";
}

/**
 * 兜底防编造后置过滤（导出供单测）：兜底能力没有任何工具，不可能执行过任何
 * 操作。拦「已然声称」——已/已经/刚刚 + 操作动词，或 为你/帮你 + 动词带完成态
 * （了/好/过），以及具体编号（#\d+；#1234 事件：prompt 明令禁止仍被无视）。
 * 提议/引导句不过滤（「需要我帮你建个工单吗？请发…」——动词后跟「个」等非完成态），
 * 历史版本此处误杀正常提议（退化帮助文本），2026-09-30 拆分已然/未然。
 * 命中即整条丢弃回帮助文本；误伤的最坏后果是回退帮助文本，方向安全。
 */
export function isFabricatedReply(text: string): boolean {
  if (/#\d+/.test(text)) return true;
  // 2026-10-07 补 记录/记下：deepseek-v4-flash（推理模型）实测爱说「已记录：R42 项目 = x」
  const VERBS = "(?:创建|建立|建好|建了|建|执行|完成|处理|派发|关闭|重开|评论|更新|记录|记下|登记)";
  // 已然声称第一式：已/已经/刚刚 + 动词（「已创建」「刚刚处理」自身即完成态）
  if (new RegExp(`(?:已(?!知)(?:经)?|刚刚|刚)[^。；！？\\n]{0,12}${VERBS}`).test(text)) return true;
  // 已然声称第二式：为你/帮你 + 动词 + 完成态后缀（「帮你建好了」）；
  // 提议句「帮你建个…」动词后非完成态，不命中
  if (new RegExp(`(?:为您|为你|帮你|帮您|替你|替您)[^。；！？\\n]{0,12}${VERBS}[了好过]`).test(text)) return true;
  return false;
}

// ── RSI 递归自我改进：召回注入 + 对话沉淀（TASK_ASSISTANT_RSI=0 整体关闭） ──

/** 兜底对话轮沉淀/规则固化的 agent 标识（服务端按 agent 隔离记忆与规则） */
const ASSISTANT_AGENT_ID = "feishu-task-assistant";

function rsiEnabled(): boolean {
  return process.env.TASK_ASSISTANT_RSI !== "0";
}

// ── 发言人 → 太忆空间映射（2026-10-10）：RSI 读写两半边统一用成员 space_*。
// 此前写半边直接用飞书 open_id 当 user_id，记忆落在 ou_ 名下——日报/晨报按人
// 检索（按登记空间查）永远看不到；未绑定发言人也不该写出孤儿 id（与群聊沉淀
// 节点同一口径：只写登记空间）。30s 缓存，身份对齐页改绑定即生效。 ──
const TIMEM_SPACE_TTL_MS = 30_000;
/** 按登记表路径缓存：身份对齐页换绑定/TTL 过期才重读（env 换路径立即生效，测试友好） */
let timemSpaceCache: { at: number; path: string | undefined; byOpenId: Map<string, string> } | null = null;

function timemSpaceFor(senderId?: string): string | undefined {
  if (!senderId) return undefined;
  const now = Date.now();
  const path = teamRegistryPath();
  if (!timemSpaceCache || timemSpaceCache.path !== path || now - timemSpaceCache.at > TIMEM_SPACE_TTL_MS) {
    const byOpenId = new Map<string, string>();
    if (path) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
          members?: Array<{ timem_user_ids?: string[]; feishu_open_ids?: string[] }>;
        };
        for (const m of raw.members ?? []) {
          const space = m.timem_user_ids?.[0];
          if (!space) continue;
          for (const oid of m.feishu_open_ids ?? []) byOpenId.set(String(oid), space);
        }
      } catch {
        // 登记表读取失败按全未绑定处理（只影响 RSI，不阻断主链路）
      }
    }
    timemSpaceCache = { at: now, path, byOpenId };
  }
  return timemSpaceCache.byOpenId.get(senderId);
}

function teamRegistryPath(): string | undefined {
  if (process.env.TEAM_IDENTITY_REGISTRY) return process.env.TEAM_IDENTITY_REGISTRY;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "config", "timem-team-registry.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** 跨层软调用：拒绝/超时一律返回 undefined——RSI 两个半边都是增益，不是依赖，
 *  任何故障都不允许拖慢或阻断兜底回复主链路 */
async function softCall<T>(
  ctx: SeamContext,
  ref: CapabilityRef,
  req: unknown,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      ctx.call(ref, req) as Promise<T>,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ])) as T | undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 兜底前召回（RSI 读半边）：经验规则 + 相关记忆 → 提示词注入块；两手都空返回 "" */
async function recallContextBlock(
  userText: string,
  ctx: SeamContext,
  userId?: string,
): Promise<string> {
  // 未绑定成员查不到有意义的空间记忆，直接跳过召回（省两次空查）
  const space = timemSpaceFor(userId);
  if (!space) return "";
  const [rulesRes, memoryRes] = await Promise.all([
    softCall<{ ok?: boolean; value?: { rules?: Array<{ name?: string; lesson?: string }> } }>(
      ctx,
      timemRuleRecallRefForAssistant,
      {
        query: userText,
        judge_scene_text: userText,
        user_id: space,
        agent_id: ASSISTANT_AGENT_ID,
        mode: "auto",
        top_k: 3,
      },
      8_000,
    ),
    softCall<{ ok?: boolean; value?: { results?: Array<{ content?: string }> } }>(
      ctx,
      timemMemoryRefForAssistant,
      { query: userText, user_id: space, agent_id: ASSISTANT_AGENT_ID, limit: 3 },
      8_000,
    ),
  ]);
  const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  const rules = (rulesRes?.ok ? (rulesRes.value?.rules ?? []) : [])
    .map((r) => (r.lesson ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((l, i) => `${i + 1}. ${clip(l)}`);
  const memories = (memoryRes?.ok ? (memoryRes.value?.results ?? []) : [])
    .map((m) => (m.content ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((c, i) => `${i + 1}. ${clip(c)}`);
  if (!rules.length && !memories.length) return "";
  const parts: string[] = [];
  if (rules.length) parts.push(`【经验规则——团队沉淀的既定经验，与其冲突时以规则为准】\n${rules.join("\n")}`);
  if (memories.length) parts.push(`【相关记忆——过往交互沉淀的背景】\n${memories.join("\n")}`);
  return parts.join("\n");
}

/**
 * LLM 兜底回复：正则意图未命中时，以「项目小助理」身份生成自然回复。
 * 输出过防编造过滤（isFabricatedReply），失败/关闭时回退帮助文本（不比改动前差）。
 * RSI：回复前注入召回的经验规则/记忆（读半边），成功作答后把本轮问答沉淀进
 * TiMEM（写半边）——两半边均 best-effort，失败静默降级为原行为。
 * 短时记忆：注入 per-chat 最近对话窗口（conversationWindow），让「刚才说的」可接。
 * 前缀缓存（M1）：system prompt 全静态，动态召回块在历史之后作第二条 system——
 * 前缀逐字节稳定以命中上游缓存（docs/token-mechanism-plan.md M1）。
 */
async function generateFallbackReply(
  userText: string,
  ctx: SeamContext,
  userId?: string,
  chatKey?: string,
): Promise<string> {
  if (!llmFallbackEnabled()) return HELP_TEXT;
  try {
    const recallBlock = rsiEnabled() ? await recallContextBlock(userText, ctx, userId) : "";
    const history = conversationWindow(chatKey ?? "");
    // M1 前缀缓存（2026-10-07，合订版铁律「不改前缀」）：system prompt 保持全静态，
    // 动态召回块挪到历史之后作第二条 system 消息——静态前缀逐字节稳定，上游前缀
    // 缓存（ksyun-deepseek-v4.1 实测命中 90%）才能命中；召回块在历史后不影响理解。
    const messages: Array<{ role: string; content: string }> = [
        {
          role: "system",
          content:
            "你是飞书群里的「项目小助理」，一个真实、好打交道的协作同事，负责管理飞书任务与 Gitea 工单（git.aigility.cloud）：建任务/工单（须 @仓库）、查列表、关闭/重开/评论、项目概览、任务派发确认（「确认派发 #N」/「取消派发 #N」）。\n" +
            "【对话方式】像正常群聊同事一样说话：先理解对方到底想干什么（包括纠正、补充、确认、闲聊、情绪），再决定怎么回。可用口语化中文，2-4 句为主，不堆砌格式。\n" +
            "【场景应对】① 用户在纠正或补充之前的信息（如「项目错了」「是 XX 仓库的」）：先接住纠正（「收到，是我认错了仓库」），再确认正确信息，最后引导补一条正确指令（如「可以再发一次：建工单 @正确的仓库：<标题>」）。② 用户描述了一个需求但没带 @仓库：给出「你想要的应该是：建工单 @某仓库：<标题>」，并主动问一句仓库归属（不知道就别猜）。③ 闲聊/感谢/吐槽：简短自然回应即可，不强行导流到指令。④ 问「你能干什么」：用一两句话概括职责，别把整张指令清单倒出来，对方要细节再给。⑤ 用户报告缺陷/进展或转发讨论片段（内容常为多人对话）：先接住内容、用一两句确认理解（能看出像待办的点就点出来）；如实告知「这段已进入我的自动汇总，稍后会同步到机器人群」；对方想立刻立条目时引导「建任务：<标题>」（工单则「建工单 @仓库：<标题>」），缺仓库就问一句。\n" +
            "【硬约束】你没有连接任何系统、没有任何工具，永远不可能替用户执行操作：严禁声称已创建/已执行/已完成/已记录任何任务或工单，严禁给出具体的任务或工单编号（#数字 也不行）；提议时用「可以发『建任务：<标题>』」这类引导句式，不要说「我帮你建/我来建」（那是你做不到的事）；不确定时引导用户用指令表达。不要输出 markdown 标题或代码块。",
        },
        ...history,
    ];
    if (recallBlock) {
      // 动态召回必须在稳定前缀之后：否则每条消息前缀都变，前缀缓存全废
      messages.push({
        role: "system",
        content: `【本次召回的团队经验与记忆】\n${recallBlock}\n回答时优先依据以上内容；以上内容没有的信息不要编造。`,
      });
    }
    messages.push({ role: "user", content: userText });
    const r = (await ctx.call(llmInferenceRefForPersona, {
      model: fallbackModel(),
      messages,
      temperature: 0.2,
      // 1500 而非 500：推理型模型的思考 tokens 计入 max_tokens，500 会被思考
      // 耗尽导致正文为空（2026-10-07 实测定位，「部分输入空响应」的真因）
      max_tokens: 1500,
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
      // RSI 写半边：真实问答轮沉淀进 TiMEM（回退帮助文本的轮次不沉淀）。
      // user_id 用成员 space_*（timemSpaceFor）；未绑定发言人不写——避免孤儿
      // ou_ id 记忆，与群聊沉淀节点同一口径。
      if (rsiEnabled()) {
        const space = timemSpaceFor(userId);
        if (!space) {
          console.log(`[feishu-task-assistant] 发言人未绑定太忆空间，本轮问答不沉淀 (${userId ?? "unknown"})`);
        } else {
          const saved = await softCall<{ ok?: boolean }>(
            ctx,
            timemMemoryWriteRefForAssistant,
            {
              content: `用户问：${clipForMemory(userText)}\n小助理答：${clipForMemory(text)}`,
              user_id: space,
              agent_id: ASSISTANT_AGENT_ID,
              domain: "feishu-task-assistant",
            },
            6_000,
          );
          if (!saved?.ok) {
            console.error("[feishu-task-assistant] 兜底问答沉淀失败（忽略，不影响回复）");
          }
        }
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

/** 沉淀内容截断：问/答各留前 400 字，避免长转发刷爆记忆条目 */
function clipForMemory(s: string): string {
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

// ── 短时记忆：per-chat 滚动上下文窗口（TASK_ASSISTANT_CONTEXT=0 关闭） ──
//
// 兜底此前是严格单轮（messages=[system, user]），「刚才说的」「你发的那个」一律
// 接不住（2026-10-07 日志实锤：省略编号的批量纠正、R 码回填都掉兜底且无上下文）。
// 本窗口按群记录最近 N 轮 user/assistant 消息（含指令回执；帮助文本兜底不记
// assistant 半边），生成兜底回复时作为对话历史注入。纯内存 + TTL，重启即清——
// 它就是短时记忆；跨会话的稳定事实仍归 TiMEM（RSI 长期记忆半边）。

interface ContextTurn {
  role: "user" | "assistant";
  content: string;
  at: number;
}

const CONTEXT_TTL_MS = 2 * 60 * 60_000;
const CONTEXT_MAX_TURNS = 16;
const CONTEXT_TURN_CHARS = 300;
const conversationBuffers = new Map<string, ContextTurn[]>();

function contextWindowEnabled(): boolean {
  return process.env.TASK_ASSISTANT_CONTEXT !== "0";
}

function pruneContext(chatKey: string): ContextTurn[] {
  const now = Date.now();
  const buf = (conversationBuffers.get(chatKey) ?? []).filter((t) => now - t.at <= CONTEXT_TTL_MS);
  conversationBuffers.set(chatKey, buf);
  return buf;
}

/** 记一轮对话；assistant 半边仅在真实回复时记（帮助文本/空回复不进短时记忆） */
export function recordAssistantTurn(chatKey: string, userText: string, assistantReply: string): void {
  if (!contextWindowEnabled() || !chatKey) return;
  const buf = pruneContext(chatKey);
  const now = Date.now();
  buf.push({ role: "user", content: userText.slice(0, CONTEXT_TURN_CHARS), at: now });
  if (assistantReply && assistantReply !== HELP_TEXT) {
    buf.push({ role: "assistant", content: assistantReply.slice(0, CONTEXT_TURN_CHARS), at: now });
  }
  while (buf.length > CONTEXT_MAX_TURNS) buf.shift();
  // 内存护栏：群数量破百时淘汰最久无动静的群（正常规模远达不到）
  if (conversationBuffers.size > 100) {
    const oldest = [...conversationBuffers.entries()]
      .filter(([k]) => k !== chatKey)
      .sort((a, b) => (a[1][a[1].length - 1]?.at ?? 0) - (b[1][b[1].length - 1]?.at ?? 0))[0]?.[0];
    if (oldest) conversationBuffers.delete(oldest);
  }
}

/** 取对话历史（不含本轮，调用方在其后拼接当前 user 消息） */
export function conversationWindow(chatKey: string): Array<{ role: "user" | "assistant"; content: string }> {
  if (!contextWindowEnabled() || !chatKey) return [];
  return pruneContext(chatKey).map(({ role, content }) => ({ role, content }));
}

/** 测试辅助：清空全部短时记忆 */
export function resetAssistantConversationBuffers(): void {
  conversationBuffers.clear();
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
    // 免@群消息（摘要播报群的指令回复）走「仅指令」模式：正则未命中时保持
    // 静默（不 LLM 兜底不帮助文本），避免群聊闲聊被回复刷屏
    const commandOnly =
      request.chat_type === "group" && request.mentioned_bot === false;

    if (intent.kind === "help") {
      if (commandOnly) {
        return ok({ response: "", agent_name: AGENT_NAME, session_id: ctx.sessionId, trace_id: ctx.traceId });
      }
      const rawText = request.user_input ?? "";
      // 近乎命中（明显想说核验指令但格式没对上）→ 针对性短提示，绝不甩全文帮助
      if (/^(?:安排执行者|指派执行者|任务归属|归属任务|跳过任务|确认\s*#?\d)/.test(rawText.trim())) {
        response =
          "指令没认出来。核验格式：确认 <#编号> ｜ 任务归属 <#编号> 项目简称 ｜ 安排执行者 <#编号> 姓名。 " +
          "引用单条摘要回复时编号可省略；多条指令可分行或直接连写。";
      } else {
        // 正则未命中（含显式问「帮助」，均落 help 意图）：LLM 自然语言兜底
        // （输出过防编造过滤，失败/关闭回退帮助文本；RSI 召回注入+沉淀；短时记忆窗口）
        response = await generateFallbackReply(rawText, ctx, request.user_id, request.session_id);
      }
    } else if (intent.kind === "list") {
      // 「我的任务」升级为人视角全景汇总（工单 + PR + 飞书任务 + timem 记忆）；
      // briefing 不可用/失败时回落编排层的飞书任务列表（不比改动前差）
      let briefed = "";
      try {
        const b = (await ctx.call(projectBriefingRef, {
          mode: "person-brief",
          user_id: request.user_id,
        })) as { ok?: boolean; value?: { response?: string }; error?: string };
        if (b?.ok && b.value?.response) briefed = b.value.response;
      } catch (e) {
        console.error(`[feishu-task-assistant] person-brief 失败，回落任务列表: ${String(e)}`);
      }
      response = briefed;
      if (!briefed) {
        const r = (await ctx.call(
          taskIssueSyncRef,
          { mode: "intent", intent, session_id: request.session_id, root_id: request.root_id },
        )) as { ok: boolean; value?: { response?: string }; error?: string };
        response = r.ok && r.value?.response ? r.value.response : `❌ 业务处理失败：${r.error ?? "编排层无响应"}`;
      }
    } else if (intent.kind === "project-status" || intent.kind === "feedback") {
      // 项目进展 / 反馈写入：多源汇总与记忆沉淀（@orchestration/project-briefing）
      const b = (await ctx.call(
        projectBriefingRef,
        intent.kind === "project-status"
          ? { mode: "project-brief", project: intent.project }
          : { mode: "feedback", text: intent.text, user_id: request.user_id },
      )) as { ok?: boolean; value?: { response?: string }; error?: string };
      response =
        b?.ok && b.value?.response
          ? b.value.response
          : `❌ 处理失败：${b?.error ?? "编排层无响应"}`;
      // RSI 写半边加强：「反馈：以后…」是用户显式给出的长期约定，在 briefing 的
      // 记忆沉淀之外固化为经验规则（best-effort，失败不改变原回复语义）
      if (
        intent.kind === "feedback" &&
        b?.ok &&
        rsiEnabled() &&
        /^以后/.test(intent.text)
      ) {
        // user_id 同 RSI 写半边：映射到成员 space_*，未绑定不写（无主规则召回不到）
        const ruleSpace = timemSpaceFor(request.user_id);
        const rc = ruleSpace
          ? await softCall<{ ok?: boolean }>(
            ctx,
            timemRuleCreateRefForAssistant,
            {
              name: intent.text.replace(/^以后/, "").trim().slice(0, 60) || intent.text.slice(0, 60),
              situation: `用户在飞书群对「项目小助理」说：${clipForMemory(intent.text)}`,
              lesson: clipForMemory(intent.text),
              user_id: ruleSpace,
              agent_id: ASSISTANT_AGENT_ID,
              trigger_tags: ["项目小助理", "群反馈"],
            },
            8_000,
          )
          : undefined;
        if (rc?.ok) {
          response += "\n（这条已固化为经验规则，以后类似场景我会优先照办）";
        }
      }
    } else {
      // 业务全部委托编排层（含概览；need-repo 反问也在编排层做——
      // 需要实时拉可访问仓库列表）
      const r = (await ctx.call(
        taskIssueSyncRef,
        { mode: "intent", intent, session_id: request.session_id, root_id: request.root_id },
      )) as { ok: boolean; value?: { response?: string }; error?: string };
      response =
        r.ok && r.value?.response
          ? r.value.response
          : `❌ 业务处理失败：${r.error ?? "编排层无响应"}`;
    }

    // 短时记忆：把本轮 (用户消息, 回复) 记进该群的滚动窗口（空回复=免@静默，不记）
    if (response) {
      recordAssistantTurn(request.session_id ?? "", request.user_input ?? "", response);
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
    "角色人格层：「项目小助理」交互形象（意图解析+帮助+兜底防编造过滤+RSI 召回/沉淀），任务/工单业务下沉 @orchestration/task-issue-sync（双建同步），我的任务/项目进展/反馈走 @orchestration/project-briefing（多源汇总+timem 沉淀）",
  version: "1.6.0",
  provides: [feishuTaskAssistantService],
  consumes: [
    taskIssueSyncRef,
    projectBriefingRef,
    llmInferenceRefForPersona,
    timemMemoryRefForAssistant,
    timemMemoryWriteRefForAssistant,
    timemRuleRecallRefForAssistant,
    timemRuleCreateRefForAssistant,
  ],
  preferredCarrier: CarrierKind.Thread,
};
