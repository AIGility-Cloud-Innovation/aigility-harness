/**
 * feishu-ingress 单测 — 飞书机器人通用入口
 *
 * 验证:
 *   1. 服务定义归属 Infrastructure 层且 consumes @persona/timem-support
 *   2. 缺凭证时明确报错
 *   3. 路由映射：默认通配 → timem-support；指定会话 → 指定角色
 *   4. health: 未连接时 healthy=false
 */
import { describe, it, expect, vi } from "vitest";
import { feishuIngressProvider, feishuIngressService, feishuTimemSupportRef } from "./feishu-ingress.js";

/** 最小 SeamContext 测试替身 */
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

describe("feishu-ingress", () => {
  it("服务定义归属 Infrastructure 层，consumes @persona/timem-project-assistant", () => {
    expect(feishuIngressService.id).toBe("@infrastructure/feishu-ingress");
    expect(feishuIngressService.layer).toBe("infrastructure");
    expect(feishuTimemSupportRef.id).toBe("@persona/timem-project-assistant");
  });

  it("缺凭证时明确报错", async () => {
    const ctx = mockCtx({ response: "hi" });
    const result = await feishuIngressProvider.execute(
      { appId: "", appSecret: "" },
      ctx as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Feishu 凭证缺失");
    }
  });

  it("带凭证时启动成功并返回 stop 函数", async () => {
    const ctx = mockCtx({ response: "hi" });
    const result = await feishuIngressProvider.execute(
      { appId: "cli_test", appSecret: "secret_test" },
      ctx as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.appId).toBe("cli_test");
      expect(typeof result.value.stop).toBe("function");
      // 清理：断开连接防止测试悬挂
      await result.value.stop();
    }
  });

  it("health: 未连接时 healthy=false", async () => {
    const health = await feishuIngressProvider.health();
    expect(health.healthy).toBe(false);
  });
});
// ── threadAnchorFor — 话题锚定（回复落到话题串下） ───────────────────

describe("threadAnchorFor", () => {
  const base = { messageId: "om_msg_1" };

  it("群聊带 rootId（话题内发言）→ 锚到话题根", async () => {
    const { threadAnchorFor } = await import("./feishu-ingress.js");
    expect(threadAnchorFor({ chatType: "group", rootId: "om_root_9", ...base })).toBe("om_root_9");
  });

  it("群聊无 rootId（普通群聊 @bot）→ 锚到触发消息本身（回复语义）", async () => {
    const { threadAnchorFor } = await import("./feishu-ingress.js");
    expect(threadAnchorFor({ chatType: "group", ...base })).toBe("om_msg_1");
  });

  it("私聊 → 不锚定（直发）", async () => {
    const { threadAnchorFor } = await import("./feishu-ingress.js");
    expect(threadAnchorFor({ chatType: "p2p", rootId: "om_root_9", ...base })).toBeUndefined();
  });
});

// ── messageText — 行首 @mention 剥离（#1234 根因回归） ────────────────

describe("messageText — 行首 @mention 剥离", () => {
  const asMsg = (over: Record<string, unknown>) => over as never;

  it("群聊 @bot 前缀（bot 名形态）→ 剥掉行首一次", async () => {
    const { messageText } = await import("./feishu-ingress.js");
    expect(
      messageText(
        asMsg({ content: "@项目小助理 建任务：@platform-backend 账单导出异常", mentionedBot: true }),
      ),
    ).toBe("建任务：@platform-backend 账单导出异常");
  });

  it("群聊 @bot 前缀（@_user_1 占位符形态）→ 同样剥掉", async () => {
    const { messageText } = await import("./feishu-ingress.js");
    expect(
      messageText(asMsg({ content: "@_user_1 建任务：修复导出", mentionedBot: true })),
    ).toBe("建任务：修复导出");
  });

  it("正文中间的 @仓库 保留（extractRepoSpec 解析仓库的载体）", async () => {
    const { messageText } = await import("./feishu-ingress.js");
    expect(
      messageText(asMsg({ content: "@项目小助理 建任务 @video：修复导出", mentionedBot: true })),
    ).toBe("建任务 @video：修复导出");
  });

  it("未 @bot（被动收集路径）→ 不改写原文", async () => {
    const { messageText } = await import("./feishu-ingress.js");
    expect(
      messageText(asMsg({ content: "@张三 帮我看看这个", mentionedBot: false })),
    ).toBe("@张三 帮我看看这个");
  });

  it("无 @ 前缀（p2p 私聊）→ 原样返回", async () => {
    const { messageText } = await import("./feishu-ingress.js");
    expect(messageText(asMsg({ content: "我的任务", mentionedBot: false }))).toBe("我的任务");
  });
});
