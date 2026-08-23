/**
 * @aigility-arch/layer-infrastructure — Protocol Adapter Provider
 *
 * 能力：@infrastructure/protocol-adapter
 * 职责：机器对机器的协议翻译 / 入口归一化。无论外部用哪种协议打进来
 * （Anthropic Messages、OpenAI Chat、OpenAI Responses），统一翻译成内部标准
 * OpenAI Chat 格式，经 Seam 按能力 ID 调用 @cognitive/llm-inference，
 * 再把结果翻译回原协议。
 *
 * 与 LiteLLM 的关系：本 Provider 只 import core（不 import 任何 Provider），
 * 通过 ctx.call() 消费认知层能力，绝不直连 48724 端口。
 *
 * 移植自 /home/johnny/.local/share/api-router/proxy.py（4 个翻译纯函数），
 * 保留了工具调用（tool_use / function_call）的双向翻译。
 */

import { LayerId, CarrierKind, PluginState, ok, err } from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  CapabilityRef,
  Result,
  HealthStatus,
} from "@aigility-arch/core";
import type {
  LlmInferenceRequest,
  LlmInferenceResponse,
  ChatMessage,
} from "@aigility-arch/layer-cognitive";

// ── 内部标准引用（声明消费认知层能力）────────────────────────────

export const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};

// ── 语义类型 ─────────────────────────────────────────────────────

export type ProtocolKind = "anthropic-messages" | "openai-chat" | "openai-responses";

export interface ProtocolAdapterRequest {
  protocol: ProtocolKind;
  /** 外部客户端打进来的原始 JSON */
  body: Record<string, unknown>;
  /** 请求头（用于 detectCaller 追踪调用者） */
  headers?: Record<string, string>;
}

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed";
  output: Array<Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export type ProtocolAdapterResponse =
  | { protocol: "anthropic-messages"; response: AnthropicMessageResponse }
  | { protocol: "openai-chat"; response: LlmInferenceResponse }
  | { protocol: "openai-responses"; response: ResponsesResponse };

// ── 服务定义 ─────────────────────────────────────────────────────

export const protocolAdapterService: ServiceDefinition<
  ProtocolAdapterRequest,
  ProtocolAdapterResponse
> = {
  id: "@infrastructure/protocol-adapter",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "协议翻译 / 入口归一化（Anthropic / OpenAI Chat / OpenAI Responses → 内部标准）",
};

// ── 翻译纯函数（移植 proxy.py）───────────────────────────────────

const genId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** 根据 User-Agent / X-App 识别调用者，用于 LiteLLM 用量追踪。 */
export function detectCaller(headers?: Record<string, string>): string {
  const ua = (headers?.["user-agent"] ?? headers?.["User-Agent"] ?? "").toLowerCase();
  const xApp = (headers?.["x-app"] ?? headers?.["X-App"] ?? "").toLowerCase();
  if (ua.includes("claude") || ua.includes("anthropic") || xApp.includes("claude-code")) return "claude-code";
  if (ua.includes("codex") || xApp.includes("codex")) return "codex";
  if (ua.includes("opencode") || xApp.includes("opencode")) return "opencode";
  if (ua.includes("openclaw") || xApp.includes("openclaw")) return "openclaw";
  if (ua.includes("hermes") || xApp.includes("hermes")) return "hermes";
  if (ua.includes("openai")) return "openai-client";
  return "unknown";
}

/** 将调用者标识注入请求体 user 字段（供 LiteLLM SpendLogs 记录）。 */
export function injectUser(body: Record<string, unknown>, caller: string): Record<string, unknown> {
  if (!("user" in body)) body["user"] = caller;
  return body;
}

const DEFAULT_MODEL = "huawei-glm-5.2";

/** Anthropic Messages → OpenAI Chat（内部标准）。 */
export function anthropicToOpenai(body: Record<string, unknown>): LlmInferenceRequest {
  const messages: ChatMessage[] = [];

  // system 块
  if ("system" in body) {
    const s = body["system"];
    if (typeof s === "string") {
      messages.push({ role: "system", content: s });
    } else if (Array.isArray(s)) {
      const parts = s
        .filter((b) => (typeof b === "string") || (typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text"))
        .map((b) => (typeof b === "string" ? b : String((b as Record<string, unknown>)["text"] ?? "")));
      if (parts.length) messages.push({ role: "system", content: parts.join("\n") });
    }
  }

  // messages
  for (const msg of (body["messages"] as Array<Record<string, unknown>>) ?? []) {
    const role = (msg["role"] as string) ?? "user";
    const content = msg["content"];
    if (typeof content === "string") {
      messages.push({ role: role as ChatMessage["role"], content });
    } else if (Array.isArray(content)) {
      const tp: string[] = [];
      const tc: LlmInferenceRequest["messages"][number]["tool_calls"] = [];
      const tr: ChatMessage[] = [];
      for (const b of content) {
        if (typeof b === "string") {
          tp.push(b);
        } else if (typeof b === "object" && b !== null) {
          const t = (b as Record<string, unknown>)["type"];
          if (t === "text") tp.push(String((b as Record<string, unknown>)["text"] ?? ""));
          else if (t === "tool_use") {
            const bb = b as Record<string, unknown>;
            tc!.push({
              id: String(bb["id"] ?? genId("call")),
              type: "function",
              function: {
                name: String(bb["name"] ?? ""),
                arguments: JSON.stringify(bb["input"] ?? {}),
              },
            });
          } else if (t === "tool_result") {
            const bb = b as Record<string, unknown>;
            let c = bb["content"];
            if (Array.isArray(c)) {
              c = c.map((x) => (typeof x === "object" && x !== null ? String((x as Record<string, unknown>)["text"] ?? "") : String(x))).join("\n");
            } else if (typeof c !== "string") {
              c = JSON.stringify(c);
            }
            tr.push({ role: "tool", content: String(c ?? ""), tool_call_id: String(bb["tool_use_id"] ?? "") });
          }
        }
      }
      if (tr.length) messages.push(...tr);
      else if (tc!.length) messages.push({ role: role as ChatMessage["role"], content: tp.join("\n") || null, tool_calls: tc });
      else messages.push({ role: role as ChatMessage["role"], content: tp.join("\n") || "" });
    }
  }

  const oai: LlmInferenceRequest = {
    model: String(body["model"] ?? DEFAULT_MODEL),
    messages,
  };
  for (const k of ["max_tokens", "temperature", "top_p"] as const) {
    if (typeof body[k] === "number") oai[k] = body[k] as number;
  }
  if ("stop_sequences" in body) oai["stop"] = body["stop_sequences"] as string[];
  if ("stream" in body) oai["stream"] = body["stream"] as boolean;

  // tools → function 类型
  if (Array.isArray(body["tools"])) {
    const ot: Array<Record<string, unknown>> = [];
    for (const tool of body["tools"] as Array<Record<string, unknown>>) {
      if (String(tool["type"] ?? "").startsWith("computer_")) continue;
      ot.push({
        type: "function",
        function: {
          name: tool["name"] ?? "",
          description: tool["description"] ?? "",
          parameters: tool["input_schema"] ?? { type: "object", properties: {} },
        },
      });
    }
    if (ot.length) oai["tools"] = ot;
  }
  if ("tool_choice" in body) {
    const tc = body["tool_choice"];
    if (typeof tc === "object" && tc !== null) {
      const t = (tc as Record<string, unknown>)["type"];
      const m: Record<string, unknown> = {
        auto: "auto",
        any: "required",
        tool: { type: "function", function: { name: (tc as Record<string, unknown>)["name"] ?? "" } },
      };
      oai["tool_choice"] = m[String(t)] ?? null;
    } else if (typeof tc === "string") {
      oai["tool_choice"] = tc;
    }
  }
  return oai;
}

/** OpenAI Responses → OpenAI Chat（内部标准）。 */
export function responsesToChat(body: Record<string, unknown>): LlmInferenceRequest {
  const messages: ChatMessage[] = [];
  if (body["instructions"]) messages.push({ role: "system", content: String(body["instructions"]) });

  const inp = body["input"];
  if (typeof inp === "string") {
    messages.push({ role: "user", content: inp });
  } else if (Array.isArray(inp)) {
    for (const item of inp) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const itype = it["type"];
      if (itype === "function_call") {
        const callId = String(it["call_id"] ?? it["id"] ?? genId("call"));
        const args = it["arguments"] ? String(it["arguments"]) : "{}";
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callId, type: "function", function: { name: String(it["name"] ?? ""), arguments: args } },
          ],
        });
      } else if (itype === "function_call_output") {
        const callId = String(it["call_id"] ?? genId("call"));
        let out = it["output"] ?? "";
        if (typeof out !== "string") out = JSON.stringify(out);
        messages.push({ role: "tool", tool_call_id: callId, content: out as string });
      } else {
        let content = it["content"] ?? "";
        if (Array.isArray(content)) {
          const parts = content
            .filter((b) => typeof b === "object" && b !== null && ["input_text", "output_text"].includes(String((b as Record<string, unknown>)["type"])))
            .map((b) => String((b as Record<string, unknown>)["text"] ?? ""));
          content = parts.join("\n") || "";
        }
        messages.push({ role: (it["role"] as ChatMessage["role"]) ?? "user", content: String(content) });
      }
    }
  }

  const oai: LlmInferenceRequest = { model: String(body["model"] ?? ""), messages };
  if (typeof body["max_output_tokens"] === "number") oai["max_tokens"] = body["max_output_tokens"] as number;
  else if (typeof body["max_tokens"] === "number") oai["max_tokens"] = body["max_tokens"] as number;
  if (typeof body["stream"] === "boolean") oai["stream"] = body["stream"] as boolean;

  if (Array.isArray(body["tools"])) {
    const ct: Array<Record<string, unknown>> = [];
    for (const t of body["tools"] as Array<Record<string, unknown>>) {
      if (typeof t !== "object" || t === null) continue;
      if ("function" in t && typeof t["function"] === "object") {
        ct.push({ type: "function", function: t["function"] });
      } else if (String(t["type"]) === "function" && "name" in t) {
        ct.push({
          type: "function",
          function: { name: t["name"] ?? "", description: t["description"] ?? "", parameters: t["parameters"] ?? { type: "object", properties: {} } },
        });
      } else if ("name" in t) {
        ct.push({
          type: "function",
          function: { name: t["name"] ?? "", description: t["description"] ?? "", parameters: t["parameters"] ?? { type: "object", properties: {} } },
        });
      }
    }
    if (ct.length) oai["tools"] = ct;
  }
  if ("tool_choice" in body) oai["tool_choice"] = body["tool_choice"];
  return oai;
}

/** 内部标准响应 → Anthropic Messages 响应。 */
export function openaiResponseToAnthropic(resp: LlmInferenceResponse, model: string): AnthropicMessageResponse {
  const blocks: AnthropicContentBlock[] = [];
  if (resp.message.content) blocks.push({ type: "text", text: resp.message.content });
  for (const tc of resp.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });

  const fm: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    function_call: "tool_use",
    content_filter: "end_turn",
  };
  const u = resp.usage;
  return {
    id: genId("msg"),
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: fm[resp.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
  };
}

/** 内部标准响应 → OpenAI Responses 响应。 */
export function chatToResponses(resp: LlmInferenceResponse, model: string): ResponsesResponse {
  const output: Array<Record<string, unknown>> = [];
  const txt = resp.message.content ?? "";
  if (txt) {
    output.push({
      id: genId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: txt }],
    });
  }
  for (const tc of resp.message.tool_calls ?? []) {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      args = {};
    }
    const callId = tc.id;
    output.push({
      id: callId,
      type: "function_call",
      call_id: callId,
      name: tc.function.name,
      arguments: JSON.stringify(args),
    });
  }
  const u = resp.usage;
  return {
    id: genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.total_tokens },
  };
}

// ── Provider 实现：消费 @cognitive/llm-inference ─────────────────

const protocolAdapterProvider: Provider<ProtocolAdapterRequest, ProtocolAdapterResponse> = {
  service: protocolAdapterService,
  name: "infrastructure-protocol-adapter",
  state: PluginState.Active,

  async execute(
    request: ProtocolAdapterRequest,
    ctx: SeamContext,
  ): Promise<Result<ProtocolAdapterResponse>> {
    const caller = detectCaller(request.headers);
    const body = injectUser({ ...request.body }, caller);
    const model = String(body["model"] ?? DEFAULT_MODEL);

    ctx.emit({
      type: "protocol-adapter.translate",
      layer: LayerId.Infrastructure,
      payload: { protocol: request.protocol, caller, model },
      traceId: ctx.traceId,
    });

    if (request.protocol === "anthropic-messages") {
      const internal = anthropicToOpenai(body);
      const llm = await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
        llmInferenceRef,
        internal,
      );
      if (!llm.ok) return err(llm.error);
      return ok({
        protocol: "anthropic-messages",
        response: openaiResponseToAnthropic(llm.value, model),
      });
    }

    if (request.protocol === "openai-responses") {
      const internal = responsesToChat(body);
      const llm = await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
        llmInferenceRef,
        internal,
      );
      if (!llm.ok) return err(llm.error);
      return ok({
        protocol: "openai-responses",
        response: chatToResponses(llm.value, model),
      });
    }

    // openai-chat：已经是内部标准，直接透传（无需翻译）
    const internal: LlmInferenceRequest = {
      model,
      messages: (body["messages"] as ChatMessage[]) ?? [],
    };
    for (const k of ["max_tokens", "temperature", "top_p", "stop", "stream", "tools", "tool_choice"] as const) {
      if (body[k] !== undefined) (internal as unknown as Record<string, unknown>)[k] = body[k];
    }
    const llm = await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
      llmInferenceRef,
      internal,
    );
    if (!llm.ok) return err(llm.error);
    return ok({ protocol: "openai-chat", response: llm.value });
  },

  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "protocol adapter ready (consumes @cognitive/llm-inference)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export function createProtocolAdapterProvider(): Provider<ProtocolAdapterRequest, ProtocolAdapterResponse> {
  return protocolAdapterProvider;
}