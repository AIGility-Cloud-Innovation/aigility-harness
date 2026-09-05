/**
 * L3 感知交互层: Codex 网页应用生成器 (codex-chat)
 *
 * 与用户「直接沟通」的网页应用生成角色——根据描述生成/修改网页应用，
 * 把生成任务委托给 L4 的 @orchestration/codex-agent 执行真实编码。
 *
 * 设计要点:
 *   - 专注建应用: 用户说「建个记账本」→ codex-agent 生成前端 HTML
 *   - 可操作目录受限: 只能在沙箱根 examples/apps 内生成/修改文件
 *   - 绑定实现 @orchestration/codex-agent (与 @persona/coder 一致, 可换底层)
 *
 * 与 coder 的区别: coder 偏「通用编码任务执行」, codex-chat 偏「网页应用
 * 生成/修改」, 且带目录沙箱限制。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import { resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
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

export interface CodexChatRequest {
  /** 用户输入 (如"帮我建个记账本" / "写个排序") */
  user_input: string;
  /** 可选: 工作目录 (默认调用方 cwd) */
  cwd?: string;
  /** 可选: 会话 ID */
  session_id?: string;
}

export interface CodexChatResponse {
  /** 角色反馈文字 (结果/计划/摘要) */
  response: string;
  /** 编码执行的原始结果 (codex-agent 返回) */
  raw?: unknown;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const codexChatService: ServiceDefinition<CodexChatRequest, CodexChatResponse> = {
  id: "@persona/codex-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "Codex 网页应用生成器：根据描述生成/修改网页应用（委托 L4 codex-agent + 目录沙箱限制）",
};

/** 委托的 L4 编码 Agent (实现无关; 换 claude-code/opencode 只改这一处) */
export const codexAgentRef: CapabilityRef = {
  id: "@orchestration/codex-agent",
  versionRange: "^1.0.0",
};

// ── 可操作目录白名单 ──────────────────────────────────────────────
// codex-chat 委托 codex-agent 时, 工作目录必须落在允许的沙箱目录内,
// 防止用户让 codex 在任意目录 (如 /home /etc) 写文件/执行命令。

/** 默认沙箱根: examples/apps (应用产物目录)。可从环境变量覆盖。 */
// 从本文件位置推导仓库根: src → layer-persona → packages → 仓库根 (dirname 后上 3 级)
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const DEFAULT_SANDBOX_ROOT = resolve(REPO_ROOT, "examples", "apps");

/** 确保沙箱根存在 (codex 首次执行前必须存在) */
export function ensureSandboxRoot(): string {
  const root = resolve(DEFAULT_SANDBOX_ROOT);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

/** 允许 codex 操作的工作目录白名单 (解析为绝对路径, 防 .. 逃逸) */
export function getAllowedCwd(cwd?: string): string {
  const root = resolve(DEFAULT_SANDBOX_ROOT);
  if (!cwd) return ensureSandboxRoot();
  const target = resolve(root, cwd);
  // 必须位于沙箱根内, 不允许 .. 逃逸到沙箱外
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`工作目录不在允许范围内: ${cwd} (仅允许 ${root} 内)`);
  }
  return target;
}

// ── 角色人设提示词 ────────────────────────────────────────────────

const CODEX_CHAT_SYSTEM_PROMPT = `你是「Codex 网页应用生成器」，一位专注的网页应用生成专家。你的核心能力是：根据用户的描述，生成可直接运行的网页应用。

你能帮用户做的事:
1. 创建小型网页应用 (记账本 / TODO 清单 / 班主任小本本 等): 生成自包含、可直接打开的单 HTML 页面
2. 修改已有应用: 用户说「给记账本加个统计」, 你直接改
3. 简单答疑: 应用相关的小问题可以回答, 但核心是生成/修改应用

对话风格:
- 像朋友一样直接沟通: 先理解用户真实意图, 必要时确认关键细节
- 主动: 用户说「建个 X」, 你直接动手生成, 完成后给访问方式
- 简洁: 结论先行, 代码用代码块, 不啰嗦

创建应用的规则:
- 生成自包含的单 HTML 文件 (内嵌 CSS/JS), 可直接浏览器打开
- 有简单的数据存储 (localStorage 或后端 API)
- 完成后告诉用户: 应用已创建, 如何访问/使用

工作目录限制 (必须遵守):
- 你只能在你被指定的工作目录内生成/修改文件
- 绝对禁止通过 .. 或绝对路径访问工作目录之外的位置
- 所有产出文件必须落在指定工作目录内

失败处理:
- 如实说明失败原因, 不编造成功结果
- 涉及外部依赖/环境问题时说明前提条件`;

// ── Provider 实现 ────────────────────────────────────────────────

const codexChatProvider: Provider<CodexChatRequest, CodexChatResponse> = {
  service: codexChatService,
  name: "persona-codex-chat-text",
  state: PluginState.Active,
  async execute(
    request: CodexChatRequest,
    ctx: SeamContext,
  ): Promise<Result<CodexChatResponse>> {
    // 1. 角色形象: Codex 网页应用生成器
    const agentName = "Codex 网页应用生成器";

    // 2. 校验工作目录在沙箱白名单内 (防任意目录写文件/执行命令)
    let cwd: string;
    try {
      cwd = getAllowedCwd(request.cwd);
    } catch (e) {
      return ok({
        response: `无法执行：${String((e as Error).message)}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }

    // 3. 构建带角色知识的任务 (委托 L4 codex-agent 执行真实编码)
    const task = {
      prompt: `${CODEX_CHAT_SYSTEM_PROMPT}\n\n用户任务:\n${request.user_input}\n\n工作目录: ${cwd}\n`,
      cwd,
      // 规划阶段模型: 默认 deepseek-v4-pro 在本网关不存在 → 用 qwen-turbo
      planningModel: "qwen-turbo",
    };

    // 4. 委托 L4: codex-agent 负责 规划(经认知层 LLM) + spawn Codex 执行
    const result = await ctx.call(codexAgentRef, task);

    // 5. 由同一角色形象反馈
    if (!result.ok) {
      return ok({
        response: `任务未完成：${result.error}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }
    const raw = result.value as { text?: string; plan?: string };
    const response =
      raw?.text && raw.text.length > 0
        ? raw.text
        : "任务已完成，但未返回可展示的文本结果。";

    return ok({
      response,
      ...(result.value ? { raw: result.value } : {}),
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "codex-chat ready (委托 @orchestration/codex-agent)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { codexChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/codex-chat",
  layer: LayerId.Persona,
  description: "感知层：Codex 对话助手角色形象（直接沟通 + 委托 L4 codex-agent）",
  version: "0.1.0",
  provides: [codexChatService],
  consumes: [codexAgentRef],
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
    return [codexChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};