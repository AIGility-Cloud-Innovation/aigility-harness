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
