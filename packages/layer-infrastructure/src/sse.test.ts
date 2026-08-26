/**
 * sse.ts 纯函数单元测试 —— SSE 帧编码不与任何 socket 绑定，可直接断言字符串。
 */
import { describe, it, expect } from "vitest";
import {
  encodeSseFrame,
  encodeSseComment,
  SSE_DONE,
  buildChatChunk,
  encodeChatCompletionStream,
  SSE_CONTENT_TYPE,
} from "./sse.js";

describe("encodeSseFrame", () => {
  it("把 JSON 值编码为 data: 帧 + 空行分隔", () => {
    expect(encodeSseFrame({ hello: "world" })).toBe('data: {"hello":"world"}\n\n');
  });

  it("字符串值按 JSON 序列化", () => {
    expect(encodeSseFrame("done")).toBe('data: "done"\n\n');
  });
});

describe("encodeSseComment", () => {
  it("编码注释/心跳帧", () => {
    expect(encodeSseComment("keep-alive")).toBe(": keep-alive\n\n");
  });
});

describe("SSE_DONE / CONTENT_TYPE", () => {
  it("结束帧为 OpenAI 约定 [DONE]", () => {
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });

  it("Content-Type 为 text/event-stream", () => {
    expect(SSE_CONTENT_TYPE).toBe("text/event-stream; charset=utf-8");
  });
});

describe("buildChatChunk", () => {
  it("构造 OpenAI chat.completion.chunk 结构", () => {
    const chunk = buildChatChunk({
      id: "chatcmpl-abc",
      model: "qwen-turbo",
      delta: { role: "assistant", content: "你好" },
    });
    expect(chunk.id).toBe("chatcmpl-abc");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe("qwen-turbo");
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].delta).toEqual({ role: "assistant", content: "你好" });
    expect(chunk.choices[0].finish_reason).toBeNull();
    expect(chunk.created).toBeTypeOf("number");
  });

  it("可携带 finish_reason 与 usage", () => {
    const chunk = buildChatChunk({
      id: "chatcmpl-abc",
      model: "m",
      delta: {},
      finishReason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(chunk.choices[0].finish_reason).toBe("stop");
    expect(chunk.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});

describe("encodeChatCompletionStream", () => {
  it("输出 role 帧 → 内容帧 → 收尾帧 → [DONE]", () => {
    const frames = encodeChatCompletionStream({
      id: "chatcmpl-abc",
      model: "qwen-turbo",
      content: "你好世界",
      finishReason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    expect(frames).toHaveLength(4);

    // 首帧：assistant 角色声明
    const first = JSON.parse(frames[0].slice("data: ".length).trim());
    expect(first.choices[0].delta.role).toBe("assistant");

    // 内容帧：完整文本
    const second = JSON.parse(frames[1].slice("data: ".length).trim());
    expect(second.choices[0].delta.content).toBe("你好世界");

    // 收尾帧：finish_reason + usage
    const third = JSON.parse(frames[2].slice("data: ".length).trim());
    expect(third.choices[0].finish_reason).toBe("stop");
    expect(third.usage.total_tokens).toBe(14);

    // 结束帧
    expect(frames[3]).toBe(SSE_DONE);
  });

  it("空内容也输出完整帧流（不会缺帧）", () => {
    const frames = encodeChatCompletionStream({
      id: "chatcmpl-empty",
      model: "m",
      content: "",
    });
    expect(frames).toHaveLength(4);
    const contentFrame = JSON.parse(frames[1].slice("data: ".length).trim());
    expect(contentFrame.choices[0].delta.content).toBe("");
  });
});