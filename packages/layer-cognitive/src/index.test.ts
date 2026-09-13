/**
 * @aigility-harness/layer-cognitive — stub provider 单测
 *
 * 覆盖：stub echo、litellmProvider 存在性、manifest/plugin、类型导出。
 */
import { describe, it, expect } from "vitest";
import {
  llmInferenceService,
  manifest,
  plugin,
} from "./index.js";
import type { LlmInferenceRequest, LlmInferenceResponse } from "./index.js";

describe("layer-cognitive exports", () => {
  it("llmInferenceService 有正确的 id 和 layer", () => {
    expect(llmInferenceService.id).toBe("@cognitive/llm-inference");
    expect(manifest.layer).toBe("cognitive");
  });

  it("manifest provides 包含 llmInferenceService", () => {
    expect(manifest.provides).toContain(llmInferenceService);
  });

  it("plugin getProviders() 返回非空列表", async () => {
    const providers = plugin.getProviders();
    expect(providers.length).toBeGreaterThan(0);
    // 至少应包含 litellm 和 stub provider
    for (const p of providers) {
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("execute");
    }
  });

  it("LlmInferenceRequest / Response 类型兼容结构", () => {
    const req: LlmInferenceRequest = {
      model: "qwen-turbo",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 64,
      temperature: 0.7,
      top_p: 0.9,
      stop: [],
      stream: false,
      tools: [],
      tool_choice: null,
    };
    const res: LlmInferenceResponse = {
      text: "hello",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: "stop" as const,
      model: "qwen-turbo",
    };
    expect(req.model).toBe("qwen-turbo");
    expect(res.text).toBe("hello");
    expect(res.finish_reason).toBe("stop");
  });
});

describe("stub provider usage 估算", () => {
  it("usage 不再是假数据: prompt 按 messages 估算, prompt+completion=total, 且上报计量", async () => {
    const stub = plugin
      .getProviders()
      .find((p) => p.name === "cognitive-llm-inference-stub");
    expect(stub).toBeTruthy();

    const emitted: Array<{ type: string; payload: unknown }> = [];
    const meteringCalls: unknown[] = [];
    const ctx = {
      sessionId: "s-1",
      traceId: "t-1",
      callerLayer: "cognitive",
      addEffect: () => "e",
      emit: (e: { type: string; payload: unknown }) => emitted.push(e),
      getState: () => undefined,
      setState: () => {},
      call: async (ref: { id: string }, req: unknown) => {
        meteringCalls.push({ ref: ref.id, req });
        return { ok: true, value: {} } as never;
      },
    } as never;

    const result = await stub!.execute(
      {
        model: "stub-llm@0.1.0",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "你好世界hello" }, // 7 字符 → 4 token (ceil)
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usage = result.value.usage;
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    expect(result.value.model).toBe("stub-llm@0.1.0");

    // 用量上报: emit llm.usage 事件 + ctx.call token-metering record
    expect(emitted.some((e) => e.type === "llm.usage")).toBe(true);
    const rec = meteringCalls[0] as { ref: string; req: { action: string; record: { source: string; userId: string } } };
    expect(rec.ref).toBe("@infrastructure/token-metering");
    expect(rec.req.action).toBe("record");
    expect(rec.req.record.source).toBe("estimated");
    expect(rec.req.record.userId).toBe("s-1"); // 未带 userId 时退回 sessionId
  });
});
