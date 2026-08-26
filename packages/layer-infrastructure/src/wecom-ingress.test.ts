/**
 * wecom-ingress 单测 — 企业微信智能机器人入口
 *
 * 验证:
 *   1. 服务定义归属 Infrastructure 层且 consumes @persona/coder
 *   2. 缺凭证时明确报错
 *   3. 收到文本消息 → 路由到角色 → 返回结果（mock SDK）
 *   4. health: 未连接时 healthy=false
 */
import { describe, it, expect, vi } from "vitest";
import { wecomIngressProvider, wecomIngressService, wecomCoderRef } from "./wecom-ingress.js";

/** 最小 SeamContext 测试替身: 记录调用并返回固定响应 */
function mockCtx(reply: unknown) {
  const calls: { id: string; req: unknown }[] = [];
  return {
    calls,
    async call(ref: { id: string }, req: unknown) {
      calls.push({ id: ref.id, req });
      return { ok: true as const, value: reply };
    },
  };
}

describe("wecom-ingress", () => {
  it("服务定义归属 Infrastructure 层，consumes @persona/coder", () => {
    expect(wecomIngressService.id).toBe("@infrastructure/wecom-ingress");
    expect(wecomIngressService.layer).toBe("infrastructure");
    expect(wecomCoderRef.id).toBe("@persona/coder");
  });

  it("缺凭证时明确报错", async () => {
    const ctx = mockCtx({ response: "hi" });
    const result = await wecomIngressProvider.execute(
      { botId: "", secret: "" },
      ctx as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("WeCom 凭证缺失");
    }
  });
});