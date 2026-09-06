/**
 * L1 底座层: SSE (Server-Sent Events) 帧编码 — 纯函数原子模块
 *
 * SSE 是「传输模式」，不是独立能力：它必须挂在某个 socket/response 上才有
 * 意义，单独成插件会造出内核无法驱动的空洞能力。因此不注册为插件，而是
 * 被 http-ingress（node:http）直接复用；将来 Hono 备件 / 其他传输实现想
 * 换装时，import 同一个 helper 即可 —— 一个实现，多处传输复用。
 *
 * 本模块只做三件事（纯函数，无状态）：
 *   - encodeSseFrame(data)      JSON → 一条 SSE data 帧
 *   - encodeSseComment(text)    注释/心跳帧
 *   - writeSseHeaders(res)      向 node:http ServerResponse 写 SSE 响应头
 *
 * 配合 http-ingress 的流式分支使用：请求体带 stream:true 时，把
 * protocol-adapter 返回的响应编码为 OpenAI chat.completion.chunk 帧流，
 * 以 data: [DONE] 收尾（与 OpenAI 兼容网关的 SSE 格式一致）。
 */

/** SSE 响应 Content-Type 头（OpenAI 兼容网关通用） */
export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/** 把任意 JSON 序列化值编码为一条 SSE data 帧（含结尾空行分隔）。 */
export function encodeSseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 编码一条 SSE 注释帧（可用于心跳 / keep-alive）。 */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** 流结束标记帧（OpenAI 兼容网关约定）。 */
export const SSE_DONE = "data: [DONE]\n\n";

/** 向 node:http ServerResponse 写入 SSE 响应头。 */
export function writeSseHeaders(
  res: {
    writeHead: (
      status: number,
      headers?: Record<string, string | number | string[]>,
    ) => unknown;
  },
): void {
  res.writeHead(200, {
    "Content-Type": SSE_CONTENT_TYPE,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/**
 * 构造一条 OpenAI chat.completion.chunk 帧（delta 增量）。
 * 流式链路复用同一结构，客户端（OpenAI SDK / curl -N）可直接解析。
 */
export function buildChatChunk(opts: {
  id: string;
  model: string;
  delta: { role?: string; content?: string | null; tool_calls?: unknown };
  finishReason?: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  created?: number;
}): Record<string, unknown> {
  const {
    id,
    model,
    delta,
    finishReason = null,
    usage,
    created = Math.floor(Date.now() / 1000),
  } = opts;
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 把一条内部标准响应（LlmInferenceResponse）编码为 OpenAI 兼容的
 * SSE 帧数组：第一帧携带 role + 首块内容，随后 (可选) 逐段内容，最后一帧
 * 携带 finish_reason + usage，并以 [DONE] 收尾。
 *
 * 返回帧字符串数组，由调用方逐条写出（或整体拼接）。
 */
export function encodeChatCompletionStream(opts: {
  id: string;
  model: string;
  content: string;
  /** assistant 消息携带的工具调用 (编码为 delta.tool_calls 流式帧) */
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  finishReason?: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}): string[] {
  const { id, model, content, toolCalls, finishReason = "stop", usage } = opts;
  const frames: string[] = [];

  // 首帧：声明 assistant 角色 + 首个内容片（空内容也发 role 帧，OpenAI 同款）
  frames.push(encodeSseFrame(buildChatChunk({ id, model, delta: { role: "assistant", content: "" } })));

  // 内容分块（单块发出；如需 token 级流式，后续在 litellm provider 侧切分）
  frames.push(encodeSseFrame(buildChatChunk({ id, model, delta: { content } })));

  // 工具调用帧：每个 tool_call 一帧 delta (OpenAI 流式工具调用格式, index 对应顺序)
  (toolCalls ?? []).forEach((tc, index) => {
    frames.push(
      encodeSseFrame(
        buildChatChunk({
          id,
          model,
          delta: {
            tool_calls: [
              {
                index,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
              },
            ],
          },
        }),
      ),
    );
  });

  // 收尾帧：finish_reason + usage
  frames.push(encodeSseFrame(buildChatChunk({ id, model, delta: {}, finishReason, usage })));

  // 流结束标记
  frames.push(SSE_DONE);
  return frames;
}

// ── OpenAI Responses 协议 SSE (responses 事件流) ─────────────────
//
// codex (wire_api="responses") 走 /v1/responses 时期望的事件序列:
//   response.created → response.output_item.added → response.output_text.delta
//   → response.output_item.done → response.completed
// 规范要点: 每个事件 data 必须带 "type" 字段(与 event 名一致),
//   codex 按 data.type 路由事件, 缺 type 的事件会被丢弃。
// 事件均不带 "data: " 前缀, 是带 event: 字段的 SSE（OpenAI Responses 规范）。

/** 编码一条带 event 名的 Responses SSE 帧: `event: <name>\ndata: <json>\n\n` */
export function encodeResponsesEvent(
  event: string,
  data: Record<string, unknown>,
): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 构造 response 基础对象（各事件共用） */
function responseBase(opts: {
  responseId: string;
  model: string;
  created: number;
  status?: "in_progress" | "completed";
}): Record<string, unknown> {
  return {
    id: opts.responseId,
    object: "response",
    created_at: opts.created,
    model: opts.model,
    status: opts.status ?? "in_progress",
  };
}

/** 把一条 ResponsesResponse 编码为 Responses SSE 帧数组（含终结帧）.
 * 支持全部 output item 类型: message (text) 与 function_call (工具调用).
 * function_call 事件序列: output_item.added → function_call_arguments.delta
 *   → function_call_arguments.done → output_item.done (codex 依赖此序列捕获工具调用). */
export function encodeResponsesStream(opts: {
  responseId: string;
  model: string;
  created?: number;
  /** 完整 output 数组 (chatToResponses 的产物), 含 message 与 function_call */
  output: Array<Record<string, unknown>>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}): string[] {
  const {
    responseId,
    model,
    created = Math.floor(Date.now() / 1000),
    output,
    usage,
  } = opts;

  const frames: string[] = [];

  // 1. response.created — 会话创建 (data 带 type, response 包裹整体)
  frames.push(
    encodeResponsesEvent("response.created", {
      type: "response.created",
      response: responseBase({ responseId, model, created }),
    }),
  );

  // 2. 逐个 output item 编码
  output.forEach((item, outputIndex) => {
    const itemType = String(item["type"] ?? "message");
    if (itemType === "function_call") {
      const args = String(item["arguments"] ?? "{}");
      frames.push(
        encodeResponsesEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { ...item, status: "in_progress" },
        }),
      );
      frames.push(
        encodeResponsesEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: item["id"],
          output_index: outputIndex,
          delta: args,
        }),
      );
      frames.push(
        encodeResponsesEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: item["id"],
          output_index: outputIndex,
          arguments: args,
        }),
      );
      frames.push(
        encodeResponsesEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: { ...item, status: "completed" },
        }),
      );
      return;
    }
    // message item: 文本增量
    const content = Array.isArray(item["content"]) ? item["content"] : [];
    const text = content
      .filter((c) => typeof c === "object" && c !== null)
      .map((c) => String((c as Record<string, unknown>)["text"] ?? ""))
      .join("");
    const itemId = String(item["id"] ?? `msg_${outputIndex}`);
    frames.push(
      encodeResponsesEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      }),
    );
    frames.push(
      encodeResponsesEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: text,
      }),
    );
    frames.push(
      encodeResponsesEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { ...item, status: "completed" },
      }),
    );
  });

  // 3. response.completed — 结束 (带 usage + 完整 output, response 包裹整体)
  const completedResponse: Record<string, unknown> = {
    ...responseBase({ responseId, model, created, status: "completed" }),
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
          },
        }
      : {}),
    output,
  };
  frames.push(
    encodeResponsesEvent("response.completed", {
      type: "response.completed",
      response: completedResponse,
    }),
  );

  // 4. 流结束标记
  frames.push(SSE_DONE);
  return frames;
}
