/**
 * LLM Inference 契约类型 — 跨层共享的内部标准（OpenAI Chat 格式）。
 *
 * 这些类型下沉在 core：任何层（如 infrastructure 的 protocol-adapter）
 * 都可以引用契约类型而不依赖 layer-cognitive 实现，符合
 * 「每层只依赖比自己小的层号」的单向依赖规则。
 * 能力本体（Provider 实现）仍在 layer-cognitive。
 */

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

import type { CapabilityRef } from "./types.js";

/** @cognitive/llm-inference 能力引用（消费方按此声明 consumes） */
export const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};
