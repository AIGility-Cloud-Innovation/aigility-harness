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
  CapabilityRef,
} from "@aigility-harness/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TimemClient } from "@timem/dsh-plugin-timem";
import {
  timemMemoryService,
  timemMemoryWriteService,
  createTimemMemoryProvider,
  createTimemMemoryWriteProvider,
  type TimemMemoryClientLike,
  type TimemMemorySearchRequest,
} from "./timem-memory-provider.js";

// ── LLM Inference 契约（类型下沉 core，此包只做 re-export 保持兼容）─
export type {
  ToolCall,
  ChatMessage,
  LlmInferenceRequest,
  LlmInferenceResponse,
} from "@aigility-harness/core";
export { llmInferenceRef } from "@aigility-harness/core";
import type {
  LlmInferenceRequest,
  LlmInferenceResponse,
  ToolCall,
} from "@aigility-harness/core";

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

// ── Token 估算与用量上报 ─────────────────────────────────────────
// 上游未返回 usage 时按字符粗估（中英混合 ~2 字符/token），仅作量级参考；
// 真实成本核算以上游实测（source: measured）为准。计量归因键 userId 优先，
// 缺失退回 sessionId（按用户统计的准确性取决于调用方是否携带身份）。

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 2);
}

/** 输入 token 估算 (预检与 usage 兜底共用) */
function estimatePromptTokens(request: LlmInferenceRequest): number {
  return request.messages.reduce(
    (n, m) => n + estimateTokens(String(m.content ?? "")),
    0,
  );
}

function estimateUsage(
  request: LlmInferenceRequest,
  text: string,
): LlmInferenceResponse["usage"] {
  const promptTokens = estimatePromptTokens(request);
  const completionTokens = estimateTokens(text);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

const tokenMeteringRef: CapabilityRef = {
  id: "@infrastructure/token-metering",
  versionRange: "^1.0.0",
};

const creditRef: CapabilityRef = {
  id: "@infrastructure/credit",
  versionRange: "^1.0.0",
};

/**
 * 余额预检: 仅显式带 userId 的请求; 估算消耗按"输入 ×2"保守估计 (输出长度
 * 未知)。积分服务缺失/异常时 fail-open 放行, 不阻断推理; 明确余额不足才拒绝。
 */
async function precheckCredit(
  ctx: SeamContext,
  request: LlmInferenceRequest,
): Promise<string | null> {
  if (!request.userId) return null;
  try {
    const promptTokens = estimatePromptTokens(request);
    const res = await ctx.call(creditRef, {
      action: "check",
      userId: request.userId,
      model: request.model,
      promptTokens,
      completionTokens: promptTokens,
    });
    if (!res.ok) return null; // 积分服务不可用 → 放行
    const v = res.value as { allowed?: boolean; balance?: number; estCredits?: number };
    if (v.allowed === false) {
      return `积分不足: 当前余额 ${v.balance ?? 0} 积分, 本次调用预计消耗约 ${v.estCredits ?? "?"} 积分 (模型 ${request.model})。请充值后再试。`;
    }
  } catch {
    // fail-open
  }
  return null;
}

/** 用量上报：emit 事件 + ctx.call 计量插件（尽力而为，失败不影响推理主链路） */
function reportUsage(
  ctx: SeamContext,
  providerName: string,
  request: LlmInferenceRequest,
  model: string,
  usage: LlmInferenceResponse["usage"],
  source: "measured" | "estimated",
): void {
  const record = {
    userId: request.userId ?? ctx.sessionId,
    attribution: request.userId ? ("user" as const) : ("session" as const),
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    provider: providerName,
    model,
    source,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
  ctx.emit({
    type: "llm.usage",
    layer: LayerId.Cognitive,
    payload: record,
    traceId: ctx.traceId,
  });
  void ctx
    .call(tokenMeteringRef, { action: "record", record })
    .catch(() => {});
}

// ── Provider A：原型占位 ─────────────────────────────────────────

const stubProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> = {
  service: llmInferenceService,
  name: "cognitive-llm-inference-stub",
  state: PluginState.Active,
  async execute(
    request: LlmInferenceRequest,
    ctx: SeamContext,
  ): Promise<Result<LlmInferenceResponse>> {
    const insufficient = await precheckCredit(ctx, request);
    if (insufficient) return err(insufficient);
    const lastMsg = request.messages[request.messages.length - 1];
    const text = String(lastMsg?.content ?? "(empty)");
    // stub 不产生真实消耗: usage 为按字符口径的估算值 (estimated), 供计量
    // 链路在零依赖原型模式下跑通; 相对量级可信, 绝对数值与成本核算无意义
    const usage = estimateUsage(request, text);
    reportUsage(ctx, "cognitive-llm-inference-stub", request, "stub-llm@0.1.0", usage, "estimated");
    return ok({
      text,
      message: { role: "assistant", content: text },
      model: "stub-llm@0.1.0",
      finish_reason: "stop",
      usage,
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
// 每次调用时读 env(而非 boot 冻结): 全局 LLM 配置保存后写 env 即热生效
function litellmEndpoint(): { url: string; key: string } {
  return {
    url: process.env.LITELLM_URL ?? fileCfg.url ?? DEFAULT_LITELLM_URL,
    key: process.env.LITELLM_KEY ?? fileCfg.key ?? DEFAULT_LITELLM_KEY,
  };
}

// ── LLM 端点解析 ─────────────────────────────────────────────────
// 内部调用不经过任何 HTTP 网关：由 LLM_PROVIDER 选择认知层直连的供应商
// 适配器（进程内决策，出站仅访问模型 API 本身）。
//   - litellm (默认): OpenAI 兼容网关 → {LITELLM_URL}/v1/chat/completions
//   - bigmodel: 智谱开放平台直连 → {BASE}/chat/completions
// LLM_THINKING=disabled 可关闭 glm 深度思考（省 reasoning token）。

interface LlmEndpoint {
  name: string;
  completionsUrl: string;
  key: string;
  thinking?: "enabled" | "disabled";
}

function resolveEndpoint(): LlmEndpoint {
  const provider = process.env.LLM_PROVIDER ?? "litellm";
  const thinking =
    process.env.LLM_THINKING === "disabled" || process.env.LLM_THINKING === "enabled"
      ? (process.env.LLM_THINKING as "enabled" | "disabled")
      : undefined;
  if (provider === "bigmodel") {
    const base = process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    return {
      name: "bigmodel",
      completionsUrl: `${base}/chat/completions`,
      key: process.env.BIGMODEL_API_KEY ?? process.env.LITELLM_KEY ?? "",
      thinking,
    };
  }
  const litellm = litellmEndpoint();
  return {
    name: "litellm",
    completionsUrl: `${litellm.url}/v1/chat/completions`,
    key: litellm.key,
    thinking,
  };
}

const litellmProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> = {
  service: llmInferenceService,
  name: "cognitive-llm-inference-litellm",
  state: PluginState.Active,
  async execute(
    request: LlmInferenceRequest,
    ctx: SeamContext,
  ): Promise<Result<LlmInferenceResponse>> {
    const insufficient = await precheckCredit(ctx, request);
    if (insufficient) return err(insufficient);
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
    const endpoint = resolveEndpoint();
    if (endpoint.thinking) payload["thinking"] = { type: endpoint.thinking };
    const body = JSON.stringify(payload);

    ctx.emit({
      type: "litellm.request",
      layer: LayerId.Cognitive,
      payload: { model: request.model, msgCount: request.messages.length },
      traceId: ctx.traceId,
    });

    let resp: Response;
    try {
      resp = await fetch(endpoint.completionsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      return err(`LLM(${endpoint.name}) fetch failed: ${String(e)}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(body unreadable)");
      return err(`LLM(${endpoint.name}) HTTP ${resp.status}: ${errText}`);
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

    const text = choice.message.content ?? "";
    const model = raw.model ?? request.model;
    // 上游实测优先; 上游未回 usage 时按字符估算兜底 (estimated), 不再记 0
    const usage =
      raw.usage && (raw.usage.total_tokens > 0 || raw.usage.completion_tokens > 0)
        ? raw.usage
        : estimateUsage(request, text);
    reportUsage(
      ctx,
      "cognitive-llm-inference-litellm",
      request,
      model,
      usage,
      raw.usage ? "measured" : "estimated",
    );

    return ok({
      text,
      message: {
        role: "assistant" as const,
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      model,
      finish_reason: choice.finish_reason,
      usage,
    });
  },
  async health(): Promise<HealthStatus> {
    const endpoint = resolveEndpoint();
    if (endpoint.name !== "litellm") {
      // 直连供应商无统一 health 端点, 以"已配置"为健康判据
      return {
        healthy: Boolean(endpoint.key),
        detail: `${endpoint.name} endpoint configured${endpoint.key ? "" : " (缺少 API Key)"}`,
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      const resp = await fetch(`${litellmEndpoint().url}/health/liveliness`, {
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
  description: "认知核心层：LLM 推理（stub + litellm）+ TiMEM 记忆检索/写入",
  version: "0.3.0",
  provides: [llmInferenceService, timemMemoryService, timemMemoryWriteService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

// 环境变量指纹客户端: /dsh 页面保存配置后 env 会被原地更新,
// 这里检测指纹变化自动重建 TimemClient, 实现「保存配置即热生效」(无需重启)。
// searchMemory 带云端契约兼容: Gitea 插件 0.1.0 发 query 字段, 而 api.timem.cloud
// 要求 query_text —— 客户端调用失败时自动用 query_text 兼容重试一次。
class EnvTimemClient implements TimemMemoryClientLike {
  private inner: TimemClient | null = null;
  private fp = "";

  private ensure(): TimemClient {
    const fp = `${process.env.TIMEM_API_KEY ?? ""}|${process.env.TIMEM_BASE_URL ?? ""}`;
    if (!this.inner || this.fp !== fp) {
      this.inner = new TimemClient({
        apiKey: process.env.TIMEM_API_KEY ?? "",
        baseUrl: process.env.TIMEM_BASE_URL,
      });
      this.fp = fp;
    }
    return this.inner;
  }

  async searchMemory(req: TimemMemorySearchRequest): Promise<unknown> {
    const client = this.ensure();
    try {
      return await client.searchMemory({
        query: req.query,
        user_id: req.user_id ?? "anonymous",
        agent_id: req.agent_id,
        limit: req.limit ?? 5,
      });
    } catch (primaryErr) {
      // 兼容重试: 直接发 query_text 字段 (云端契约)
      const base = (process.env.TIMEM_BASE_URL ?? "http://localhost:8001").replace(/\/$/, "");
      const resp = await fetch(`${base}/api/v1/memory/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": process.env.TIMEM_API_KEY ?? "" },
        body: JSON.stringify({
          user_id: req.user_id,
          agent_id: req.agent_id,
          query_text: req.query,
          limit: req.limit ?? 5,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await resp.text();
      if (!resp.ok) {
        // 兼容重试也失败 → 抛出主路径错误 (更接近真实原因)
        void text;
        throw primaryErr;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw primaryErr;
      }
    }
  }

  addMemory(opts: Parameters<TimemClient["addMemory"]>[0]) {
    return this.ensure().addMemory(opts);
  }
}

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
    // timem 客户端按环境变量构造 (装配方须在 bootstrap 前注入 TIMEM_API_KEY/BASE_URL,
    // appbase 在 initAppBackend 里从 dsh_plugins 表桥接, 且保存配置时原地更新 env);
    // 未配置 key 时构造不报错, 调用期失败由 provider 内部捕获并以 ok:false 降级
    const timemClient = new EnvTimemClient();
    // LLM_PROVIDER=stub 时 stub 先注册(resolve 优先选它) —— 原型/离线自证零外部依赖;
    // 其余取值(缺省/litellm/bigmodel)仍 litellm 优先
    const llmProviders =
      process.env.LLM_PROVIDER === "stub"
        ? [stubProvider, litellmProvider]
        : [litellmProvider, stubProvider];
    return [...llmProviders, createTimemMemoryProvider(timemClient), createTimemMemoryWriteProvider(timemClient)]; // 先注册 = resolve 优先选它
  },
  getState(): PluginState {
    return pluginState;
  },
};
