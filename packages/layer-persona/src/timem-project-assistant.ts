/**
 * L3 角色人格层: timem-project-assistant —「项目小助手」机器人人格
 *
 * 面向 timem-project（TiMEM Project 3.0，本地任务执行系统）的任务助手：
 * 用户在飞书私聊/群聊 @机器人发任务指令 → 委托 L4 编排（含 codex-agent 执行）
 * → 汇报结果。
 *
 * 与 timem-support（Space 记忆云客服）严格区分：
 *   timem-support              = 太忆空间网页应用客服（space.timem.cloud）
 *   timem-project-assistant    = 本地项目任务执行助手（调度 codex 干活）
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
} from "@aigility-harness/core";

// ── 请求/响应 ────────────────────────────────────────────────────

export interface TimemProjectAssistantRequest {
  /** 用户消息（任务指令） */
  user_input: string;
  /** 用户标识（飞书 open_id；用于记忆隔离） */
  user_id?: string;
  /** 会话 ID（飞书 chat_id） */
  session_id?: string;
  /** 飞书 App ID（来源机器人身份） */
  app_id?: string;
  /** 任务来源（默认 feishu） */
  source?: string;
  /** 任务标题（默认取 user_input 前 80 字） */
  title?: string;
  /** 显式指定项目 ID（跳过项目确认，直接执行） */
  project_id?: string;
  /** 会话 ID（identify 绑定查询用） */
  conversation_id?: string;
  /** 消息 ID（幂等键：create-from-message 的 sourceMessageId） */
  message_id?: string;
  /** 聊天类型: p2p | group */
  chat_type?: string;
  /** 资源引用（图片等，透传给编排层） */
  resources?: Array<Record<string, unknown>>;
}

export interface TimemProjectAssistantResponse {
  /** 回复文本 */
  response: string;
  agent_name: string;
  session_id: string;
  trace_id: string;
}

// 编排层判别联合响应的局部 shape（不引用 orchestration 类型，层间解耦）
interface TimemTaskResponseLike {
  type?: string;
  text?: string;
  response?: string;
  taskId?: string;
  status?: string;
}

// ── 服务定义 ─────────────────────────────────────────────────────

export const timemProjectAssistantService: ServiceDefinition<
  TimemProjectAssistantRequest,
  TimemProjectAssistantResponse
> = {
  id: "@persona/timem-project-assistant",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "TiMEM Project 项目任务助手：收任务指令 → 委托编排执行（codex）→ 汇报结果",
};

// ── 角色人设提示词 ───────────────────────────────────────────────

const PROJECT_ASSISTANT_SYSTEM_PROMPT = `你是「TiMEM Project 项目小助手」，为用户在本机执行代码任务的智能助手。

## 你的职责
- 接收用户的项目任务指令（创建项目、改代码、跑测试、写脚本等）
- 理解任务后交由执行引擎（codex）在本地工作区完成，并汇报结果
- 用户确认任务、追问细节时如实回应执行情况

## 行为准则
- 收到任务先复述理解，再说明会怎么做；不确定的细节先问清（在哪个项目/仓库、验收标准）
- 执行结果如实汇报：改了哪些文件、测试是否通过、失败原因是什么
- 不编造执行结果——只有真实跑过才说完成
- 涉及项目归属（这个任务归哪个代码仓库）时，按用户指定或现有项目确认
- 回答简洁、先结论后细节

## 边界
- 不回答与任务执行无关的产品咨询（那是 timem-support 客服的事）
- 不执行未授权的危险操作（删除、覆盖、推送远程等先确认）`;

// ── Provider 实现 ────────────────────────────────────────────────

const providerName = "persona-timem-project-assistant-text";

export const timemProjectAssistantProvider: Provider<
  TimemProjectAssistantRequest,
  TimemProjectAssistantResponse
> = {
  service: timemProjectAssistantService,
  name: providerName,
  state: PluginState.Active,
  async execute(
    request: TimemProjectAssistantRequest,
    ctx: SeamContext,
  ): Promise<Result<TimemProjectAssistantResponse>> {
    const agentName = "TiMEM Project 小助手";
    const userId = request.user_id ?? "feishu-unknown";
    const input = (request.user_input ?? "").trim();

    // 确认意图：用户在「新建任务待确认」后回复 确认/执行/同意/立即执行
    const CONFIRM_RE = /^(确认|确认执行|执行|同意|好|好的|可以|立即执行|马上执行|马上跑|开始执行)/;
    const RUN_NOW_RE = /^(立即执行|马上执行|马上跑|开始执行)/;
    const pendingTaskId = ctx.getState<string>("timem_pending_task_id");
    let confirmTaskId: string | undefined;
    let promptOverride: string | undefined;
    let runNow = false;
    if (CONFIRM_RE.test(input) && pendingTaskId) {
      confirmTaskId = pendingTaskId;
      if (RUN_NOW_RE.test(input)) runNow = true;
      // 支持「确认并改提示词：<新提示词>」
      const overrideMatch = input.match(/改提示词[:：]\s*([\s\S]+)/);
      if (overrideMatch) promptOverride = overrideMatch[1].trim();
    }

    // 委托 L4 编排：TIMEM_PROJECT 真实执行桥接（UDS → agentd → codex）
    // 注：装配时若 timem-task 不可用（agentd 未起）会降级报错提示
    const result = await ctx.call(
      { id: "@orchestration/timem-task", versionRange: "^1.0.0" },
      {
        user_input: input,
        user_id: userId,
        session_id: request.session_id ?? ctx.sessionId,
        source: request.source ?? "feishu",
        title: request.title,
        project_id: request.project_id,
        conversation_id: request.conversation_id,
        message_id: request.message_id,
        chat_type: request.chat_type,
        resources: request.resources,
        ...(confirmTaskId ? { confirm_task_id: confirmTaskId } : {}),
        ...(promptOverride ? { prompt_override: promptOverride } : {}),
        ...(runNow ? { run_now: true } : {}),
      },
    );

    const value = (result as { ok: boolean; value?: unknown }).ok
      ? (result as { value?: TimemTaskResponseLike }).value
      : undefined;

    // 记住待确认任务 ID（确认闸门：用户回复「确认」时用）
    if (value?.type === "confirm" && value.taskId) {
      ctx.setState("timem_pending_task_id", value.taskId);
    } else if (
      value?.type === "task" ||
      value?.type === "error"
    ) {
      // 已确认/执行/出错 → 清掉待确认标记
      ctx.setState("timem_pending_task_id", "");
    }

    // 适配三段式判别联合：chat/ask/summary/error → text；task/confirm → response
    const response =
      value?.text ??
      value?.response ??
      "抱歉，任务执行遇到了问题，请稍后再试或查看服务日志。";

    return ok({
      response,
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "timem-project-assistant ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/timem-project-assistant",
  layer: LayerId.Persona,
  description: "角色人格层：TiMEM Project 项目任务助手（飞书项目小助手机器人）",
  version: "1.0.0",
  provides: [timemProjectAssistantService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
};
