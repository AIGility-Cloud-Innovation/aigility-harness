/**
 * L3 感知交互层: 应用报修客服角色形象 (repair-chat)
 *
 * 受理用户对 AppBase 网页应用的故障报修, 采用「延时汇总」工作流
 * (与编排层 timem-project-task 需求缓冲同款思想: 先发散, 后收敛):
 *   - 收集期: 只引导描述与给出自查步骤, 不建单、不输出 ticket 块;
 *     全程对话轮次入会话缓冲区
 *   - 汇总期: 用户显式说「就这些了/提交报修」或静默期满后, 一次 LLM 调用
 *     整合全部轮次 → 输出结构化 ```ticket``` 草稿(汇总单)
 *   - 确认期: 前端识别 ticket 块出「创建工单」按钮, 用户点按即确认建单
 *   - 建单后用户可转「网页应用开发员」进一步判断和处理
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
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface RepairChatRequest {
  /** 用户输入 */
  user_input: string;
  /** 会话 ID (可选) */
  session_id?: string;
  /** 用户标识 (大厅登录邮箱; 用于 TiMEM 记忆按用户隔离, 可选) */
  user_key?: string;
  /** 会话历史 (前端维护, 透传给编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface RepairChatResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
  /** true = LLM 不可用, 本次回复来自降级 stub */
  degraded?: boolean;
}

export const repairChatService: ServiceDefinition<RepairChatRequest, RepairChatResponse> = {
  id: "@persona/repair-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "应用报修客服：受理故障报修 → 收集期引导(不入单) → 静默/显式触发延时汇总 → 工单草稿 → 确认建单",
};

// ── Provider 实现 ────────────────────────────────────────────────

// 收集期引导提示词: 不允许 LLM 自己吐 ticket 块(汇总由延时工作流统一做)
const REPAIR_SUPPORT_PROMPT = [
  '你是「应用报修客服」, 受理用户对 AppBase 里网页应用的故障报修。请用简体中文交流。',
  '',
  '当前是【信息收集期】: 系统会在用户说「就这些了」后统一汇总建单, 你现在不需要、也不允许输出任何工单块/ticket/JSON。',
  '',
  '你要做的:',
  '1. 了解问题: 哪个应用、什么现象、期望是什么、如何复现、报错信息原文。一次只问一两个关键问题, 不要一次问一大串。',
  '2. 给出初步判断: 最可能的原因 + 用户可自行尝试的快速排查步骤。',
  '3. 适时提醒: 信息补充得差不多了, 可以回复「就这些了」, 我会整理成工单。',
  '',
  '规则:',
  '- 绝不输出 ```ticket 代码块或任何 JSON 工单结构。',
  '- 不编造不确定的原因; 涉及服务端 (登录/网络/数据库/LLM 配置) 的问题, 提示用户联系管理员检查。',
  '- 结论先行、具体可操作; 不知道的如实说。',
].join("\n");

// ── 延时汇总: 会话缓冲区 (收集期轮次 → 静默/显式触发 → 工单草稿) ──

interface RepairTurn {
  role: "user" | "assistant";
  content: string;
}

interface RepairSession {
  turns: RepairTurn[];
  /** 静默期满预计算的工单草稿(下次消息送达时呈现) */
  draft: string | null;
  timer: NodeJS.Timeout | null;
}

const repairSessions = new Map<string, RepairSession>();

/** 静默自动汇总窗口: 默认 3 分钟, env REPAIR_QUIET_MS 可调, 0=仅显式触发 */
function repairQuietMs(): number {
  const v = Number(process.env["REPAIR_QUIET_MS"]);
  return Number.isFinite(v) && v >= 0 ? v : 3 * 60_000;
}

const REPAIR_SUBMIT_RE = /^(就这些|就这些了|提交报修|建单吧|创建工单|差不多了|没有了|没别的|报修完成|整理一下吧|汇总一下)[!。.！~]*$/;

function repairSessionOf(key: string): RepairSession {
  let sess = repairSessions.get(key);
  if (!sess) {
    sess = { turns: [], draft: null, timer: null };
    repairSessions.set(key, sess);
  }
  return sess;
}

function armRepairQuiet(key: string, fire: () => void): void {
  const sess = repairSessionOf(key);
  if (sess.timer) clearTimeout(sess.timer);
  const ms = repairQuietMs();
  if (ms <= 0) return;
  const t = setTimeout(() => {
    sess.timer = null;
    fire();
  }, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  sess.timer = t;
}

/** 汇总: 整合缓冲区全部轮次 → ticket 块; 失败返回 null */
async function summarizeRepair(
  ctx: SeamContext,
  sess: RepairSession,
): Promise<string | null> {
  if (sess.turns.length === 0) return null;
  const transcript = sess.turns
    .map((t) => `${t.role === "user" ? "用户" : "客服"}: ${t.content}`)
    .join("\n");
  const res = (await ctx.call(
    { id: "@cognitive/llm-inference", versionRange: "^1.0.0" },
    {
      model: process.env.LLM_MODEL ?? "glm-4.6",
      messages: [
        {
          role: "system",
          content: [
            '你是报修工单整理器。下面是一段用户与报修客服的完整对话, 请整合出一张工单。',
            '只输出如下格式的代码块, 不要输出任何其他内容:',
            '```ticket',
            '{"title": "一句话问题标题", "app": "应用名", "detail": "现象/复现步骤/报错信息/已尝试的排查, 按对话事实汇总"}',
            '```',
            '要求: app 取对话中明确提到的应用名(没有则填 "未知应用"); detail 忠实于对话, 不编造; title 20 字以内。',
          ].join("\n"),
        },
        { role: "user", content: transcript.slice(0, 6000) },
      ],
      temperature: 0,
    },
  )) as { ok: boolean; value?: { text?: string } };
  if (!res.ok || !res.value?.text) return null;
  const m = /```ticket\s*\n([\s\S]*?)```/.exec(res.value.text);
  if (!m) return null;
  try {
    JSON.parse(m[1]!.trim());
    return "```ticket\n" + m[1]!.trim() + "\n```";
  } catch {
    return null;
  }
}

const repairChatProvider: Provider<RepairChatRequest, RepairChatResponse> = {
  service: repairChatService,
  name: "persona-repair-chat-text",
  state: PluginState.Active,
  async execute(
    request: RepairChatRequest,
    ctx: SeamContext,
  ): Promise<Result<RepairChatResponse>> {
    const agentName = "应用报修客服";
    const memUserId = request.user_key ?? "anonymous";
    const sessKey = request.user_key ?? request.session_id ?? ctx.sessionId;
    const sess = repairSessionOf(sessKey);
    const input = request.user_input.trim();

    // ── 延时汇总工作流分流 ──
    // ① 显式提交信号 → 整合缓冲区出工单草稿(前端「创建工单」按钮即确认)
    if (REPAIR_SUBMIT_RE.test(input)) {
      const draft = sess.draft ?? (await summarizeRepair(ctx, sess));
      sess.draft = null;
      if (!draft) {
        return ok({
          response: sess.turns.length === 0
            ? "还没有收到报修内容呢。请先描述: 哪个应用、什么现象、怎么复现？描述完回复「就这些了」我来整理工单。"
            : "整理失败（模型输出无法解析）。请再补充一点信息，或直接回复「就这些了」重试。",
          agent_name: agentName,
          session_id: ctx.sessionId,
          trace_id: ctx.traceId,
        });
      }
      sess.turns = []; // 草稿已交付, 清空缓冲(建单后如需补充会开启新一轮)
      return ok({
        response:
          "根据我们的沟通，我把报修信息整理成了工单草稿 👇 确认无误请点下方「创建工单」；需要补充就直接继续说。\n\n" +
          draft +
          "\n\n建单后可在工单列表点「开发员协助」交给网页应用开发员处理。",
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }

    // ② 静默期满已预计算好草稿 → 直接呈现(下一步同显式提交, 不再重复汇总)
    if (sess.draft) {
      const draft = sess.draft;
      sess.draft = null;
      sess.turns = [];
      sess.turns.push({ role: "user", content: input });
      return ok({
        response:
          "刚才我们的沟通告一段落，我已把报修信息整理成工单草稿 👇 确认无误请点下方「创建工单」；你刚说的这条我记下了，会开启新一轮整理。\n\n" +
          draft,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }

    // ③ 收集期: 正常引导回复, 但屏蔽 LLM 可能漏出的 ticket 块, 并把轮次记入缓冲
    sess.turns.push({ role: "user", content: input });

    // TiMEM 记忆召回 (尽力而为): 按用户检索相关历史记忆, 失败静默降级不阻塞对话
    let memoryBlock = "";
    try {
      const mem = await ctx.call(
        { id: "@cognitive/timem-memory", versionRange: "^1.0.0" },
        { query: request.user_input.slice(0, 200), user_id: memUserId, agent_id: "repair-chat", limit: 3 },
      );
      const value = (mem as { value?: { ok?: boolean; results?: Array<{ content: string }>; error?: string } }).value;
      const items = value?.ok ? (value.results ?? []).map((r) => r.content).filter(Boolean) : [];
      if (items.length > 0) {
        memoryBlock = `\n\n【该用户的历史相关记忆】(可参考; 与当前问题相关时提及, 不确定时询问)\n${items
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")}`;
      }
      console.log(`[repair-mem] recalled ${items.length} memories for ${memUserId}${value?.ok ? "" : ` (timem: ${value?.error ?? "unavailable"})`}`);
    } catch (e) {
      console.log(`[repair-mem] recall skipped: ${String((e as Error)?.message ?? e)}`);
    }

    const chatRequest = {
      user_input: request.user_input,
      merchant_id: "default",
      customer_id: memUserId,
      session_id: request.session_id ?? ctx.sessionId,
      user_key: request.user_key ?? memUserId,
      agent_name: agentName,
      system_prompt: REPAIR_SUPPORT_PROMPT + memoryBlock,
      ...(request.history?.length ? { history: request.history } : {}),
    };

    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      chatRequest,
    );

    const wfValue = (result as { ok: boolean; value?: { result?: string; response?: string; degraded?: boolean } })
      .value;
    let response = (result as { ok: boolean }).ok
      ? (wfValue?.result ?? wfValue?.response ?? "抱歉，我没有理解您的意思。")
      : "抱歉，智能助理暂时无法响应，请稍后重试。";

    // 收集期保险: 屏蔽 LLM 可能漏出的 ticket 块(建单只走延时汇总通道)
    response = response.replace(/```ticket[\s\S]*?```/g, "").trim();
    sess.turns.push({ role: "assistant", content: response });

    // 静默自动汇总: 用户停止输入 REPAIR_QUIET_MS 后预计算草稿(下次消息送达时呈现)
    armRepairQuiet(sessKey, () => {
      void summarizeRepair(ctx, sess)
        .then((draft) => {
          if (draft && sess.turns.length > 0) sess.draft = draft;
          console.log(`[repair-flow] quiet summarize for ${sessKey}: ${sess.draft ? "ok" : "empty"}`);
        })
        .catch(() => undefined);
    });

    // 记忆沉淀 (尽力而为): 把本次报修交互存入 TiMEM, 下次同类问题可召回。
    // 降级占位回复 (LLM 不可用) 不写入, 避免污染长期记忆。
    if ((result as { ok: boolean }).ok && !wfValue?.degraded) {
      try {
        const w = await ctx.call(
          { id: "@cognitive/timem-memory-write", versionRange: "^1.0.0" },
          {
            content: `报修对话 (${new Date().toISOString().slice(0, 10)}): 用户描述「${request.user_input.slice(0, 150)}」; 客服答复要点: ${response.slice(0, 200)}`,
            user_id: memUserId,
            agent_id: "repair-chat",
          },
        );
        const wv = (w as { value?: { ok?: boolean; error?: string } }).value;
        if (wv?.ok) console.log(`[repair-mem] saved exchange for ${memUserId}`);
        else console.log(`[repair-mem] save failed: ${wv?.error ?? "unknown"}`);
      } catch (e) {
        console.log(`[repair-mem] save skipped: ${String((e as Error)?.message ?? e)}`);
      }
    }

    return ok({
      response,
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(wfValue?.degraded ? { degraded: true } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "repair-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { repairChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/repair-chat",
  layer: LayerId.Persona,
  description: "感知层：应用报修客服角色形象（引导描述 + 工单块输出）",
  version: "0.1.0",
  provides: [repairChatService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [repairChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
