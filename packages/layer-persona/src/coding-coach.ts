/**
 * L3 感知交互层: 编码教练角色形象 (coding-coach)
 *
 * 教学模式: 分步引导用户设计一个案例应用——只引导、不真正生成/保存任何文件,
 * 最终产出可直接交给「网页应用开发员」的完整提示词。
 *
 * 设计要点:
 *   - 流程在 L4: 阶段推进/汇总/提示词产出由 @orchestration/guided-design
 *     工作流确定性驱动, 本角色只负责形象与口吻, 不自己记进度
 *   - 会话状态 (session_state) 由前端携带回传, 服务端无状态
 *   - 角色名永不含实现名, 换底层工作流只改这一处
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
  CapabilityRef,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface CodingCoachRequest {
  /** 用户输入 (如"我想给班里做个记账本") */
  user_input: string;
  /** 可选: 会话 ID */
  session_id?: string;
  /** 会话历史 */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 分步引导工作流状态 (首次缺省 = 从第 1 阶段开始; 之后原样回传上次返回值) */
  session_state?: {
    phase?: number;
    answers?: Record<number, string>;
  };
}

export interface CodingCoachResponse {
  /** 角色反馈文字 (阶段引导 / 完整提示词导语) */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
  /** 当前阶段 (1-based) */
  phase?: number;
  phase_count?: number;
  phase_title?: string;
  /** 已完成收集的阶段数, 如 "3/5" */
  progress?: string;
  /** true = 完整提示词已产出 */
  done?: boolean;
  /** done 时的完整应用提示词 */
  final_prompt?: string;
  /** 回传给前端保存的工作流状态 */
  session_state?: CodingCoachRequest["session_state"];
  /** true = 降级回复 */
  degraded?: boolean;
}

export const codingCoachService: ServiceDefinition<CodingCoachRequest, CodingCoachResponse> = {
  id: "@persona/coding-coach",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "编码教练角色形象：分步引导设计案例应用(不落地) → 最终产出完整提示词",
};

/** 委托的 L4 分步引导设计工作流 */
export const guidedDesignRef: CapabilityRef = {
  id: "@orchestration/guided-design",
  versionRange: "^1.0.0",
};

// ── Provider 实现 ────────────────────────────────────────────────

const codingCoachProvider: Provider<CodingCoachRequest, CodingCoachResponse> = {
  service: codingCoachService,
  name: "persona-coder-guided",
  state: PluginState.Active,
  async execute(
    request: CodingCoachRequest,
    ctx: SeamContext,
  ): Promise<Result<CodingCoachResponse>> {
    const agentName = "编码教练";

    // 流程交给编排层工作流: 阶段推进确定性, LLM 只产内容
    const result = (await ctx.call(
      guidedDesignRef,
      {
        user_input: request.user_input,
        session_id: request.session_id ?? ctx.sessionId,
        ...(request.history?.length ? { history: request.history } : {}),
        ...(request.session_state ? { session_state: request.session_state } : {}),
      },
    )) as { ok: boolean; value?: {
      result?: string; degraded?: boolean;
      phase?: number; phase_count?: number; phase_title?: string; progress?: string;
      done?: boolean; final_prompt?: string;
      session_state?: CodingCoachRequest["session_state"];
    } };

    if (!(result as { ok: boolean }).ok) {
      return ok({
        response: `任务未完成：${(result as { error?: string }).error ?? "工作流调用失败"}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }
    const v = result.value ?? {} as NonNullable<typeof result.value>;
    return ok({
      response: (v.result as string) ?? "（工作流未返回内容）",
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(v.phase !== undefined ? { phase: v.phase as number } : {}),
      ...(v.phase_count !== undefined ? { phase_count: v.phase_count as number } : {}),
      ...(v.phase_title !== undefined ? { phase_title: v.phase_title as string } : {}),
      ...(v.progress !== undefined ? { progress: v.progress as string } : {}),
      ...(v.done !== undefined ? { done: v.done as boolean } : {}),
      ...(v.final_prompt !== undefined ? { final_prompt: v.final_prompt as string } : {}),
      ...(v.session_state !== undefined ? { session_state: v.session_state } : {}),
      ...(v.degraded ? { degraded: true } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "coder ready (委托 @orchestration/guided-design 分步引导工作流)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { codingCoachProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/coding-coach",
  layer: LayerId.Persona,
  description: "感知层：编码教练角色形象（分步引导设计案例应用，委托 L4 guided-design 工作流）",
  version: "0.2.0",
  provides: [codingCoachService],
  consumes: [guidedDesignRef],
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
    return [codingCoachProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
