/**
 * L4 编排规划层: 分步引导设计工作流 (guided-design)
 *
 * 与 workflow-engine 占位 stub 的区别: 这是真正的多阶段工作流——
 *   - 阶段推进由插件确定性驱动 (状态机), 不依赖 LLM "自己记得走到哪"
 *   - 状态由调用方携带 (session_state), 服务无状态, 天然多设备/多会话安全
 *   - LLM 只负责内容: 提炼确认 + 提出下一阶段问题; 最终阶段产出完整提示词
 *
 * 场景: 编码教练 (@persona/coding-coach) 引导用户一步步设计一个案例应用,
 * 不真正生成/保存任何文件, 最终输出可直接交给网页应用开发员的完整提示词。
 *
 * 契约:
 *   Request  { user_input, history?, session_state? }   ← 前端每轮回传 session_state
 *   Response { result, phase, phase_count, phase_title, progress, done, final_prompt?, session_state }
 */

import {
  LayerId,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  LlmInferenceRequest,
  LlmInferenceResponse,
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// 认知层供能
const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};

// ── 阶段定义 (状态机的"边") ──────────────────────────────────────

export interface DesignPhase {
  title: string;
  /** 本阶段要收集清楚的问题要点 (LLM 据此提问) */
  collect: string;
}

export const DESIGN_PHASES: DesignPhase[] = [
  {
    title: "需求理解",
    collect: "这个应用给谁用(角色/场景)? 要解决的核心问题是什么? 最重要的那一件事是什么?",
  },
  {
    title: "功能清单",
    collect: "必备功能有哪些(按优先级排列, 先核心后锦上添花)? 第一版明确不做什么?",
  },
  {
    title: "页面与数据",
    collect: "需要哪几个页面/视图, 各展示什么? 有哪些数据实体和字段(如 学生:姓名/学号/积分)? 数据存本地还是云端?",
  },
  {
    title: "交互与边界",
    collect: "关键操作流程是怎样的(怎么录入/查看/统计)? 边界情况(空数据/录错了怎么办)? 需要多设备同步吗?",
  },
  {
    title: "确认与出提示词",
    collect: "向用户逐条汇总前面收集到的全部结论, 请用户确认或补充修改",
  },
];

const PHASE_COUNT = DESIGN_PHASES.length;

// ── 服务定义 ─────────────────────────────────────────────────────

export interface GuidedDesignSessionState {
  /** 当前所处阶段 (1-based); 到最后一阶段后保持不变, 可反复迭代提示词 */
  phase?: number;
  /** 各阶段已收集的用户原话 (phase → 用户输入) */
  answers?: Record<number, string>;
}

export interface GuidedDesignRequest {
  user_input: string;
  session_id?: string;
  /** 会话历史 (教练口吻的上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 调用方回传的工作流状态 (首次传 {phase:1} 或缺省) */
  session_state?: GuidedDesignSessionState;
}

export interface GuidedDesignResponse {
  /** 展示文本: 阶段小结 + 下一阶段引导 / 完整提示词导语 */
  result: string;
  /** 当前阶段 (1-based, 推进后的) */
  phase: number;
  phase_count: number;
  phase_title: string;
  /** 已完成收集的阶段数, 如 "3/5" */
  progress: string;
  /** true = 已产出完整提示词 */
  done: boolean;
  /** done 时的完整应用提示词 (不含围栏) */
  final_prompt?: string;
  /** 回传给调用方保存的新状态 */
  session_state: GuidedDesignSessionState;
  /** true = LLM 不可用, 本次为确定性降级引导 */
  degraded?: boolean;
}

export const guidedDesignService: ServiceDefinition<GuidedDesignRequest, GuidedDesignResponse> = {
  id: "@orchestration/guided-design",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "分步引导设计工作流：确定性阶段推进 + LLM 产出内容 + 最终完整提示词",
};

// ── Provider 实现 ────────────────────────────────────────────────

const COACH_BASE_PROMPT = [
  "你是「编码教练」，正在分步引导用户设计一个案例应用。",
  "铁律: 你只做引导与设计梳理, 绝不真正生成/保存任何应用文件或代码工程; 语气友好专业, 简体中文, 每次回复简洁 (先小结后提问)。",
].join("\n");

const FINAL_PROMPT_SPEC = [
  "最终提示词必须是一段可直接粘贴给「网页应用开发员」的完整指令, 覆盖:",
  "应用名称与目标用户 / 功能清单(按优先级) / 页面结构 / 数据实体与字段 / 关键交互与边界情况 / 技术要求(单 HTML 自包含、后端 API 一律用相对路径空基址、禁止硬编码 127.0.0.1/localhost/内网 IP)。",
].join("\n");

function clampPhase(p: unknown): number {
  const n = Number(p);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.floor(n), 1), PHASE_COUNT);
}

function extractFenced(text: string): string | null {
  const m = /```(?:app-prompt)?\s*\n?([\s\S]*?)```/.exec(text);
  const inner = m?.[1]?.trim();
  return inner && inner.length > 0 ? inner : null;
}

const guidedDesignProvider: Provider<GuidedDesignRequest, GuidedDesignResponse> = {
  service: guidedDesignService,
  name: "orchestration-guided-design",
  state: PluginState.Active,
  async execute(
    request: GuidedDesignRequest,
    ctx: SeamContext,
  ): Promise<Result<GuidedDesignResponse>> {
    const prev = request.session_state ?? {};
    const phase = clampPhase(prev.phase);
    const answers: Record<number, string> = { ...(prev.answers ?? {}) };

    const buildMessages = (system: string): LlmInferenceRequest["messages"] => [
      { role: "system", content: system },
      ...(request.history ?? []).slice(-12).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: request.user_input },
    ];

    const callLlm = async (system: string): Promise<{ text: string; degraded: boolean }> => {
      try {
        const llmRes = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
          llmInferenceRef,
          { model: process.env.LLM_MODEL ?? "glm-4.6", messages: buildMessages(system), temperature: 0.5 },
        )) as Result<LlmInferenceResponse>;
        if (llmRes.ok && llmRes.value?.text) return { text: llmRes.value.text, degraded: false };
        console.error("[guided-design] LLM 调用失败:", llmRes.ok ? "空回复" : llmRes.error);
      } catch (e) {
        console.error("[guided-design] LLM 调用异常:", e);
      }
      return { text: "", degraded: true };
    };

    // ── 最终阶段: 汇总产出完整提示词 (保持 phase, 支持反复迭代) ──
    if (phase === PHASE_COUNT) {
      const collected = Object.entries(answers)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([p, txt]) => `【第${p}阶段·${DESIGN_PHASES[Number(p) - 1]?.title ?? ""}】${txt}`)
        .join("\n");
      const system = [
        COACH_BASE_PROMPT,
        "用户已完成前四个阶段的设计梳理, 以下是各阶段收集到的结论:",
        collected || "(无, 请基于会话历史与用户本轮输入梳理)",
        "",
        "任务: 结合用户本轮输入(确认/修改/补充), 输出完整应用提示词。格式要求:",
        "1. 先用一两句话回应用户本轮的确认或修改;",
        '2. 然后原样输出一个 ```app-prompt 围栏代码块, 块内是完整提示词;',
        FINAL_PROMPT_SPEC,
        "除围栏外不要输出其他代码或文件内容。",
      ].join("\n");
      const { text, degraded } = await callLlm(system);
      const finalPrompt = extractFenced(text) ?? (degraded ? undefined : text.trim());
      const newState: GuidedDesignSessionState = { phase, answers };
      if (finalPrompt) {
        const lead = text.split("```")[0]?.trim();
        return ok({
          result: (lead && lead.length > 0 ? lead + "\n\n" : "") + "```app-prompt\n" + finalPrompt + "\n```",
          phase, phase_count: PHASE_COUNT,
          phase_title: DESIGN_PHASES[PHASE_COUNT - 1].title,
          progress: `${PHASE_COUNT}/${PHASE_COUNT}`,
          done: true,
          final_prompt: finalPrompt,
          session_state: newState,
        });
      }
      // LLM 不可用: 确定性降级引导 (阶段不回退, 用户可重试)
      return ok({
        result: "【服务降级】LLM 暂不可用，暂时无法生成完整提示词。你可以：①稍后重新发送「生成提示词」重试；②先检查服务端 LLM 配置。",
        phase, phase_count: PHASE_COUNT,
        phase_title: DESIGN_PHASES[PHASE_COUNT - 1].title,
        progress: `${PHASE_COUNT}/${PHASE_COUNT}`,
        done: false,
        session_state: newState,
        degraded: true,
      });
    }

    // ── 阶段 1..4: 意图闸门 → 实质回答则推进; 问教练/闲聊则以教练身份作答(不推进) ──
    const cur = DESIGN_PHASES[phase - 1];
    const nextPhase = phase + 1;
    const next = DESIGN_PHASES[nextPhase - 1];
    const collectedSoFar = Object.entries(answers)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([p, txt]) => `【第${p}阶段·${DESIGN_PHASES[Number(p) - 1]?.title ?? ""}】${txt}`)
      .join("\n");

    // 单次 LLM 调用同时完成「意图判断 + 内容产出」: 第一行 ADVANCE/CHAT 标签, 之后是正文
    const gateSystem = [
      COACH_BASE_PROMPT,
      `工作流共 ${PHASE_COUNT} 个阶段, 当前是第 ${phase} 阶段「${cur.title}」, 该阶段要收集: ${cur.collect}`,
      "",
      "请先判断用户最新输入的意图, 输出的第一行只写标签 (不带任何其他字符):",
      "ADVANCE —— 用户在实质回答本阶段的问题(提供了设计信息)",
      "CHAT —— 用户在问别的: 问你是谁/是不是某个工具、问流程或阶段含义、闲聊等",
      "",
      "第一行标签之后换行, 再输出正文:",
      "- 若 CHAT: 以教练身份直接回答用户的问题 (可顺势把话题引回应用设计), 不要提下一阶段的问题, 不要把该输入当作设计答案。",
      `- 若 ADVANCE: ① 用两三句提炼确认用户本轮输入 (有歧义就顺带追问); ② 作为教练提出第 ${nextPhase} 阶段「${next.title}」的关键问题, 2-4 个, 编号列出, 问题要围绕: ${next.collect}`,
      "不要输出任何代码文件, 不要提前输出完整提示词。",
    ].join("\n");
    const gate = await callLlm(gateSystem);
    const gateTag = /^\s*(ADVANCE|CHAT)\b/.exec(gate.text);
    const isChat = !gate.degraded && gateTag?.[1] === "CHAT";
    const gateBody = gate.text
      .replace(/^\s*(ADVANCE|CHAT)\b[^\n]*\n?/i, "")
      .trim();

    // CHAT: 以教练身份答问, 阶段与已收集答案均不变
    if (isChat) {
      return ok({
        result: gateBody || "我在的呢～你可以随时问我任何问题；也可以继续描述你的应用设计。",
        phase,
        phase_count: PHASE_COUNT,
        phase_title: cur.title,
        progress: `${phase - 1}/${PHASE_COUNT}`,
        done: false,
        session_state: { phase, answers },
      });
    }

    // ADVANCE (或 LLM 不可用时的确定性推进): 记录本轮答案 → 提炼确认 → 下一阶段问题
    answers[phase] = request.user_input;
    const system = [
      COACH_BASE_PROMPT,
      `工作流共 ${PHASE_COUNT} 个阶段, 用户刚回答完第 ${phase} 阶段「${cur.title}」。`,
      "此前各阶段收集到的结论:",
      collectedSoFar,
      "",
      `任务: ① 用两三句提炼确认用户本轮输入 (有歧义就顺带追问); ② 作为教练提出第 ${nextPhase} 阶段「${next.title}」的关键问题, 2-4 个, 编号列出, 问题要围绕: ${next.collect}`,
      "不要输出任何代码文件, 不要提前输出完整提示词。",
    ].join("\n");
    const { text, degraded } = gate.degraded
      ? { text: "", degraded: true }
      : { text: gateBody, degraded: false };
    const fallback = [
      `（服务降级，LLM 暂不可用——先记住你的回答，稍后可继续。）`,
      `已记录第 ${phase} 阶段「${DESIGN_PHASES[phase - 1].title}」的回答。`,
      `第 ${nextPhase} 阶段「${next.title}」请思考：${next.collect}`,
    ].join("\n");
    return ok({
      result: degraded ? fallback : text,
      phase: nextPhase,
      phase_count: PHASE_COUNT,
      phase_title: next.title,
      progress: `${phase}/${PHASE_COUNT}`,
      done: false,
      session_state: { phase: nextPhase, answers },
      ...(degraded ? { degraded: true } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: `guided-design ready (${PHASE_COUNT} 阶段: ${DESIGN_PHASES.map((p) => p.title).join(" → ")})`,
      checkedAt: new Date().toISOString(),
    };
  },
};

export { guidedDesignProvider };
