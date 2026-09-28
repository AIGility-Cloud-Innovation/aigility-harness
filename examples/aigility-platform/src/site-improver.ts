/**
 * @persona/site-improver — 平台改进专员（示例本地插件，不改框架包）
 *
 * 面向老板/用户的「网站改意见」直达通道：
 *   - 意见聊明确后自动落任务板（executor=code）→ 自动派发 ZCode 编码代理改代码 → review 人审后生效
 *   - 意见模糊时追问澄清，不建任务；平台使用咨询直接回答
 * 双入口共用 improverTurn 核心：
 *   - 市场页引擎原生角色（/api/aigility/p/site-improver/chat → 本 provider）
 *   - 数字员工对话工作台（工厂技能 site-improver → @persona/aigility-agent 委托到 improverTurn）
 * 与 workflow-engine 的记忆节点同款：TiMEM 召回/沉淀尽力而为，按用户隔离（agent_id=site-improver）。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  PluginManifest,
  LayerPlugin,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

import { createTask, type TaskRow } from "./platform.js";

// ── 标识常量（index.ts / aigility-agent 共用） ───────────────────

export const SITE_IMPROVER_SKILL_ID = "site-improver";
export const SITE_IMPROVER_PERSONA_ID = "@persona/site-improver";
export const SITE_IMPROVER_ROUTE = "/api/aigility/p/site-improver/chat";

// ── 决策提示词：LLM 只输出一个 JSON 决策对象 ─────────────────────

const IMPROVER_SYSTEM_PROMPT = [
  "你是「平台改进专员」，驻在 Aigility 智悦智能平台（智悦）中，专门接收老板与用户对平台网站本身的修改意见，并把意见转化为可执行的开发任务。",
  "平台网站主要页面：首页、数字员工（对话工作台/智能体工厂）、智能体市场、应用中心、任务板、TiMEM 空间、模型与工具管理、系统设置等。",
  "",
  "## 工作方式",
  "1. 用户提出修改意见时，先判断是否已经足够明确（改哪里、改成什么样、怎么算改好）。",
  "2. 不明确就追问（一次只问最关键的 1-2 个问题），不建任务。",
  "3. 已明确则输出 file_task 决策：title 一句话概括；detail 结构化写清【现状】【期望】【验收标准】；priority 取 高/中/低。",
  "4. 平台使用咨询（怎么用/是什么）直接回答，不建任务；不确定的内容如实说明，不编造。",
  "5. 同一意见不要重复建任务；用户只是补充细节且此前已建过任务时，按 chat 回复说明已记录。",
  "",
  "## 输出格式（严格遵守：只输出一个 JSON 对象，不要任何多余文字或代码围栏）",
  '聊天/追问：{"action":"chat","reply":"<给用户的回复>"}',
  '建任务：{"action":"file_task","title":"<一句话任务标题>","detail":"<现状/期望/验收标准>","priority":"<高|中|低>","reply":"<给用户的确认语，不要写任务号>"}',
].join("\n");

// ── 会话记忆（session_id → 最近消息；与 workflow-engine 同款兜底） ──

const SESSION_MEMORY = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
const MAX_SESSION_MSGS = 20;

// ── 决策解析 ─────────────────────────────────────────────────────

export interface ImproverDecision {
  action: "chat" | "file_task";
  reply: string;
  title?: string;
  detail?: string;
  priority?: string;
}

/** 从 LLM 原始输出提取决策 JSON；容忍代码围栏与前后缀文本，非法时返回 null（调用方按纯文本聊天处理） */
export function parseImproverDecision(raw: string): ImproverDecision | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof obj["reply"] === "string" ? obj["reply"] : "";
    if (obj["action"] === "file_task") {
      const title = typeof obj["title"] === "string" ? obj["title"].trim() : "";
      if (!title) return null; // 无标题的建任务决策视为不可执行
      return {
        action: "file_task",
        reply,
        title,
        detail: typeof obj["detail"] === "string" ? obj["detail"] : undefined,
        priority: typeof obj["priority"] === "string" ? obj["priority"] : undefined,
      };
    }
    if (obj["action"] === "chat") return { action: "chat", reply };
    return null;
  } catch {
    return null;
  }
}

// ── 核心一轮对话：召回 → LLM 决策 → 落任务 → 沉淀 ────────────────

export interface ImproverTurnRequest {
  user_input: string;
  user_key?: string;
  session_id?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ImproverTurnResponse {
  response: string;
  /** true = 本次已落任务板 */
  filed: boolean;
  task_id?: string;
  task_title?: string;
}

export interface ImproverTurnDeps {
  /** 可注入的任务落板实现（测试用）；缺省用平台任务板 createTask */
  fileTask?: typeof createTask;
}

// ── 落任务钩子：index.ts 启动时注入 dispatchExecutorTask，让改进专员
//    建的任务与 HTTP 建任务接口同样自动派发执行器（否则任务只会停在 open）──

let taskFiledHook: ((task: TaskRow) => void) | null = null;

export function setTaskFiledHook(fn: ((task: TaskRow) => void) | null): void {
  taskFiledHook = fn;
}

function notifyTaskFiled(task: TaskRow): void {
  try {
    taskFiledHook?.(task);
  } catch {
    // 派发钩子异常不阻塞给用户的回复（任务已在板上，可人工派发）
  }
}

export async function improverTurn(
  ctx: SeamContext,
  params: ImproverTurnRequest,
  deps: ImproverTurnDeps = {},
): Promise<ImproverTurnResponse> {
  const userKey = params.user_key ?? "fde-local";
  const sessionId = params.session_id ?? ctx.sessionId;
  const history = (
    params.history?.length
      ? params.history
      : SESSION_MEMORY.get(sessionId) ?? []
  ).slice(-MAX_SESSION_MSGS);

  // ── 记忆召回（尽力而为） ──
  let systemPrompt = IMPROVER_SYSTEM_PROMPT;
  try {
    const memRes = (await ctx.call<
      { query: string; user_id: string; agent_id: string; limit: number },
      { ok?: boolean; results?: Array<{ content: string }>; error?: string }
    >(
      { id: "@action/timem-memory", versionRange: "^1.0.0" },
      { query: params.user_input.slice(0, 200), user_id: userKey, agent_id: "site-improver", limit: 4 },
    )) as Result<{ ok?: boolean; results?: Array<{ content: string }>; error?: string }>;
    const memValue = memRes.ok ? memRes.value : undefined;
    const items = memValue?.ok ? (memValue.results ?? []).map((r) => r.content).filter(Boolean) : [];
    if (items.length > 0) {
      systemPrompt += `\n\n【这位用户此前提过的修改意见】(参考, 避免重复建任务)\n${items.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    }
  } catch {
    // 记忆不可用不阻塞对话
  }

  // ── LLM 决策 ──
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant", content: m.content })),
    { role: "user", content: params.user_input },
  ];
  let raw = "";
  try {
    const llmRes = (await ctx.call<
      { model: string; messages: unknown; temperature: number; userId?: string },
      { text?: string }
    >(
      { id: "@cognitive/llm-inference", versionRange: "^1.0.0" },
      {
        model: process.env.LLM_MODEL || "qwen-turbo",
        messages,
        temperature: 0.3,
        userId: userKey,
      },
    )) as Result<{ text?: string }>;
    raw = llmRes.ok ? (llmRes.value?.text ?? "") : "";
  } catch {
    raw = "";
  }
  if (!raw.trim()) {
    return { response: "抱歉，我这边暂时无法处理，请稍后再试一次。", filed: false };
  }
  const decision = parseImproverDecision(raw) ?? { action: "chat" as const, reply: raw.trim() };

  // ── 聊天/追问：更新会话记忆后直接返回 ──
  if (decision.action !== "file_task") {
    SESSION_MEMORY.set(sessionId, [
      ...history,
      { role: "user", content: params.user_input },
      { role: "assistant", content: decision.reply },
    ]);
    return { response: decision.reply || "请再描述一下你想调整的地方。", filed: false };
  }

  // ── 落任务板（executor=code, 自动派发编码代理） ──
  const fileTask = deps.fileTask ?? createTask;
  let task: TaskRow;
  try {
    task = await fileTask({
      title: decision.title!,
      detail: decision.detail,
      executor: "code",
      priority: ["高", "中", "低"].includes(decision.priority ?? "") ? decision.priority : undefined,
      createdBy: userKey,
    });
  } catch (e) {
    return {
      response: `${decision.reply}\n\n⚠️ 任务落板失败：${String((e as Error)?.message ?? e)}。请稍后重试，或直接联系开发同学。`,
      filed: false,
    };
  }
  const taskId = task.id;
  const response = [
    decision.reply || "已收到你的修改意见。",
    "",
    `✅ 已生成任务「${decision.title}」（编号 ${taskId.slice(0, 8)}），编码代理将按需求自动修改代码；改动完成后进入人审，审核通过并发布后生效。你可以在「任务板」页查看进度。`,
  ].join("\n");
  notifyTaskFiled(task);
  SESSION_MEMORY.set(sessionId, [
    ...history,
    { role: "user", content: params.user_input },
    { role: "assistant", content: response },
  ]);

  // ── 记忆沉淀（尽力而为）：只沉淀已建任务的意见 ──
  try {
    await ctx.call<{ content: string; user_id: string; agent_id: string }, { ok?: boolean; error?: string }>(
      { id: "@action/timem-memory-write", versionRange: "^1.0.0" },
      {
        content: `网站修改意见 (${new Date().toISOString().slice(0, 10)}): 「${params.user_input.slice(0, 150)}」→ 任务「${decision.title}」(${taskId.slice(0, 8)}, executor=code)`,
        user_id: userKey,
        agent_id: "site-improver",
      },
    );
  } catch {
    // 沉淀失败不阻塞回复
  }
  return { response, filed: true, task_id: taskId, task_title: decision.title };
}

// ── 请求/响应 ────────────────────────────────────────────────────

export interface SiteImproverRequest {
  user_input: string;
  user_key?: string;
  session_id?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface SiteImproverResponse {
  response: string;
  agent_name: string;
  session_id: string;
  trace_id: string;
  /** true = 本次已落任务板 */
  filed?: boolean;
  task_id?: string;
}

export const siteImproverService: ServiceDefinition<SiteImproverRequest, SiteImproverResponse> = {
  id: SITE_IMPROVER_PERSONA_ID,
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "平台改进专员：接收网站修改意见，聊清需求后自动落任务板并派发编码代理，人审后生效",
};

// ── Provider 实现 ────────────────────────────────────────────────

export const siteImproverProvider: Provider<SiteImproverRequest, SiteImproverResponse> = {
  service: siteImproverService,
  name: "persona-site-improver",
  state: PluginState.Active,
  async execute(
    request: SiteImproverRequest,
    ctx: SeamContext,
  ): Promise<Result<SiteImproverResponse>> {
    const turn = await improverTurn(ctx, request);
    return ok({
      response: turn.response,
      agent_name: "平台改进专员",
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(turn.filed ? { filed: true, task_id: turn.task_id } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "site-improver ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const siteImproverManifest: PluginManifest = {
  name: SITE_IMPROVER_PERSONA_ID,
  layer: LayerId.Persona,
  description: "角色人格层：平台改进专员（网站修改意见 → 任务板 → 编码代理）",
  version: "1.0.0",
  provides: [siteImproverService],
  consumes: [
    { id: "@cognitive/llm-inference", versionRange: "^1.0.0" },
    { id: "@action/timem-memory", versionRange: "^1.0.0" },
    { id: "@action/timem-memory-write", versionRange: "^1.0.0" },
  ],
  preferredCarrier: CarrierKind.Thread,
};

export const siteImproverPlugin: LayerPlugin = {
  manifest: siteImproverManifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [siteImproverProvider];
  },
  getState(): PluginState {
    return PluginState.Active;
  },
};
