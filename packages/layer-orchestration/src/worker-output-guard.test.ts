/** worker-output-guard 单测：报错签名判定（2026-10-22 事故回归用例）。 */
import { describe, it, expect } from "vitest";
import { looksLikeGatewayError } from "./worker-output-guard.js";

describe("looksLikeGatewayError", () => {
  it("事故原文命中（API Error 400 + Invalid model name）", () => {
    const real = `API Error: 400 {"detail":"{\\"error\\":{\\"message\\":\\"/chat/completions: Invalid model name passed in model=ksyun-deepseek-v4-flash. Call /v1/models to view available models for your key.\\"}}"}`;
    expect(looksLikeGatewayError(real)).toBe(true);
  });
  it("litellm 异常与 403 Forbidden 命中", () => {
    expect(looksLikeGatewayError("codex: turn failed: unexpected status 403 Forbidden: litellm.APIError")).toBe(true);
    expect(looksLikeGatewayError("consumer has not enabled this model")).toBe(true);
  });
  it("正常交付报告不误伤", () => {
    const good = `## 改了什么\n- BillsTable.vue 的 handleExport 增加歧义失败兼容\n\n## 怎么验证的\nvitest run 通过`;
    expect(looksLikeGatewayError(good)).toBe(false);
  });
  it("正文里讨论到 API 不误伤（需签名级特征）", () => {
    expect(looksLikeGatewayError("本次改动在请求失败时透出 API 错误信息")).toBe(false);
  });
  it("空文本安全", () => {
    expect(looksLikeGatewayError("")).toBe(false);
  });
});
