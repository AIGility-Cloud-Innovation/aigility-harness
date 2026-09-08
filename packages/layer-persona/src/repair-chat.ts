/**
 * L3 感知交互层: 应用报修客服角色形象 (repair-chat)
 *
 * 受理用户对 AppBase 网页应用的故障报修:
 *   - 引导用户把问题描述清楚 (应用/现象/复现/报错)
 *   - 给出初步判断与自查步骤
 *   - 信息足够后输出 ```ticket JSON``` 结构化工单块, 前端识别后一键建单
 *   - 建单后用户可转「网页应用生成器」进一步判断和处理
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
  description: "应用报修客服：受理故障报修 → 引导描述 → 输出工单块 → 委托 L4 回复",
};

// ── Provider 实现 ────────────────────────────────────────────────

const REPAIR_SUPPORT_PROMPT = [
  '你是「应用报修客服」, 受理用户对 AppBase 里网页应用的故障报修。请用简体中文交流。',
  '',
  '工作流程:',
  '1. 了解问题: 哪个应用、什么现象、期望是什么、如何复现、报错信息原文。一次只问一两个关键问题, 不要一次问一大串。',
  '2. 给出初步判断: 最可能的原因 + 用户可自行尝试的快速排查步骤。',
  '3. 信息足够后 (至少有应用名+现象), 在回复末尾原样输出下面格式的工单块 (便于系统识别并创建工单):',
  '```ticket',
  '{"title": "一句话问题标题", "app": "应用名(如 teacher-notebook)", "detail": "现象/复现步骤/报错信息汇总"}',
  '```',
  '4. 提醒用户: 工单创建后, 可在工单列表点「生成器协助」, 让网页应用生成器进一步判断和处理。',
  '',
  '规则:',
  '- 信息不足时不要输出 ticket 块; 问题描述有更新时可重新输出更完整的 ticket 块。',
  '- 不编造不确定的原因; 涉及服务端 (登录/网络/数据库/LLM 配置) 的问题, 提示用户联系管理员检查。',
  '- 结论先行、具体可操作; 不知道的如实说。',
].join("\n");

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
    const response = (result as { ok: boolean }).ok
      ? (wfValue?.result ?? wfValue?.response ?? "抱歉，我没有理解您的意思。")
      : "抱歉，智能助理暂时无法响应，请稍后重试。";

    // 记忆沉淀 (尽力而为): 把本次报修交互存入 TiMEM, 下次同类问题可召回
    if ((result as { ok: boolean }).ok) {
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
