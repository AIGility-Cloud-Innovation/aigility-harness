/**
 * @aigility-harness/layer-cognitive — 认知决策核心层
 *
 * 提供 LLM 推理能力 @cognitive/llm-inference。
 * 内部标准：OpenAI Chat 格式（{model, messages, max_tokens, temperature}）。
 *
 * 两个 Provider 并存，Seam 支持热切换：
 *  - cognitive-llm-inference-stub   原型占位（确定性 echo）
 *  - cognitive-llm-inference-litellm 真实推理（fetch LiteLLM，URL/key 由 env 或 config 注入）
 *
 * 按注册顺序，resolve 取第一个；生产环境可配置优先选择 litellm。
 */

import { LayerId, CarrierKind, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 内部标准格式：OpenAI Chat ─────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LlmInferenceRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
}

export interface LlmInferenceResponse {
  /** choices[0].message.content 便捷访问（可能为空串） */
  text: string;
  /** 完整 assistant 消息（含 tool_calls，供协议适配层翻译回原协议） */
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  model: string;
  finish_reason?: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── 服务定义 ─────────────────────────────────────────────────────

export const llmInferenceService: ServiceDefinition<
  LlmInferenceRequest,
  LlmInferenceResponse
> = {
  id: "@cognitive/llm-inference",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description:
    "LLM 推理能力（OpenAI Chat 内部标准），两个 Provider：stub + litellm",
};

// ── Provider A：原型占位 ─────────────────────────────────────────

const stubProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> = {
  service: llmInferenceService,
  name: "cognitive-llm-inference-stub",
  state: PluginState.Active,
  async execute(
    request: LlmInferenceRequest,
    _ctx: SeamContext,
  ): Promise<Result<LlmInferenceResponse>> {
    const lastMsg = request.messages[request.messages.length - 1];
    const text = `[stub-llm] model=${request.model} echo: ${lastMsg?.content ?? "(empty)"}`;
    return ok({
      text,
      message: { role: "assistant", content: text },
      model: "stub-llm@0.1.0",
      finish_reason: "stop",
      usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub llm inference ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── Provider B：LiteLLM 真实推理 ─────────────────────────────────
//
// LiteLLM 连接信息读取优先级（Provider 不硬编码端口/key）：
//   1. 环境变量 LITELLM_URL / LITELLM_KEY（部署时覆盖）
//   2. 仓库根 config/default.json 的 litellm 字段（本地开发直改）
//   3. 内置默认值（原型兜底，本地 127.0.0.1:48724 + sk-1234）

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_LITELLM_URL = "http://127.0.0.1:48724";
const DEFAULT_LITELLM_KEY = "sk-1234";

interface LiteLLMFileConfig {
  url?: string;
  key?: string;
}

function readFileConfig(): LiteLLMFileConfig {
  // src/tsx 运行时：packages/layer-cognitive/src → ../../../config/default.json
  // 编译后 dist 运行时：packages/layer-cognitive/dist → ../../config/default.json
  const candidates = [
    resolve(__dirname, "../../../config/default.json"),
    resolve(__dirname, "../../config/default.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as {
        litellm?: LiteLLMFileConfig;
      };
      return parsed.litellm ?? {};
    } catch {
      // 文件不存在或 JSON 非法 → 试下一个候选
    }
  }
  return {};
}

const fileCfg = readFileConfig();
const LITELLM_URL = process.env.LITELLM_URL ?? fileCfg.url ?? DEFAULT_LITELLM_URL;
const LITELLM_KEY = process.env.LITELLM_KEY ?? fileCfg.key ?? DEFAULT_LITELLM_KEY;

const litellmProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> = {
  service: llmInferenceService,
  name: "cognitive-llm-inference-litellm",
  state: PluginState.Active,
  async execute(
    request: LlmInferenceRequest,
    ctx: SeamContext,
  ): Promise<Result<LlmInferenceResponse>> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };
    for (const k of [
      "max_tokens",
      "temperature",
      "top_p",
      "stop",
      "stream",
      "tools",
      "tool_choice",
    ] as const) {
      if (request[k] !== undefined) payload[k] = request[k] as unknown;
    }
    const body = JSON.stringify(payload);

    ctx.emit({
      type: "litellm.request",
      layer: LayerId.Cognitive,
      payload: { model: request.model, msgCount: request.messages.length },
      traceId: ctx.traceId,
    });

    let resp: Response;
    try {
      resp = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LITELLM_KEY}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      return err(`LiteLLM fetch failed: ${String(e)}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(body unreadable)");
      return err(`LiteLLM HTTP ${resp.status}: ${errText}`);
    }

    const raw = (await resp.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      model?: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const choice = raw.choices?.[0];
    if (!choice?.message) {
      return err(`LiteLLM: no choices[0].message in response`);
    }

    return ok({
      text: choice.message.content ?? "",
      message: {
        role: "assistant" as const,
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      model: raw.model ?? request.model,
      finish_reason: choice.finish_reason,
      usage: raw.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  },
  async health(): Promise<HealthStatus> {
    try {
      const resp = await fetch(`${LITELLM_URL}/health/liveliness`, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        healthy: resp.ok,
        detail: resp.ok ? "LiteLLM is alive" : `LiteLLM status ${resp.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        healthy: false,
        detail: `LiteLLM unreachable: ${String(e)}`,
        checkedAt: new Date().toISOString(),
      };
    }
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@cognitive/llm-inference",
  layer: LayerId.Cognitive,
  description: "认知核心层：LLM 推理（stub + litellm）",
  version: "0.2.0",
  provides: [llmInferenceService],
  consumes: [],
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
    return [litellmProvider, stubProvider]; // litellm 先注册 = resolve 优先选它
  },
  getState(): PluginState {
    return pluginState;
  },
};
