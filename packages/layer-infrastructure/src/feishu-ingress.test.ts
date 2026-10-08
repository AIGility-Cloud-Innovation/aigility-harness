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
// ── connectWithRetry — 首连失败持续退避（静默死亡回归） ──────────────
//
// 历史故障：首连失败退避 5 次后永久放弃，进程还活着、单实例锁还持有，但
// 机器人不再响应（09-28 静默死亡一次，只能人工重启）。本组锁定修复后的
// 两条不变式：退避间隔有上限、stop() 能让重试循环退出。

describe("connectWithRetry — 首连失败持续退避", () => {
  it("退避间隔封顶，不会随失败次数无限拉长", async () => {
    const { CONNECT_BACKOFF_BASE_MS, CONNECT_BACKOFF_MAX_MS } = await import("./feishu-ingress.js");
    const delayFor = (attempt: number) =>
      Math.min(CONNECT_BACKOFF_BASE_MS * attempt, CONNECT_BACKOFF_MAX_MS);
    expect(CONNECT_BACKOFF_BASE_MS).toBeGreaterThan(0);
    expect(delayFor(1)).toBe(CONNECT_BACKOFF_BASE_MS);
    expect(delayFor(100)).toBe(CONNECT_BACKOFF_MAX_MS);
    // 封顶值应为有界常量（分钟级），否则恢复延迟会被拖到不可接受
    expect(CONNECT_BACKOFF_MAX_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("stop() 可重复调用且让重试循环退出（不残留悬挂重连）", async () => {
    const ctx = mockCtx({ response: "hi" });
    const result = await feishuIngressProvider.execute(
      { appId: "cli_test", appSecret: "secret_test" },
      ctx as never,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.stop();
      // 幂等：重复 stop 不抛（第二次调用时 activeChannel 已为 null）
      await expect(result.value.stop()).resolves.toBeUndefined();
    }
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

// ── shouldPassiveCollect — passive 静默收集判定（含防回声） ───────────

describe("shouldPassiveCollect", () => {
  const base = {
    messageId: "om_1",
    chatId: "oc_group",
    chatType: "group",
    senderId: "ou_human",
    content: "记得把账单导出修一下",
    mentionedBot: false,
  };
  const passive = { enabled: true, onCollect: () => {} };

  it("群聊免@普通消息 → 收集", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(shouldPassiveCollect(base as never, passive as never)).toBe(true);
  });

  it("@bot 消息 → 不收集（走常规指令链路）", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect({ ...base, mentionedBot: true } as never, passive as never),
    ).toBe(false);
  });

  it("私聊消息 → 默认不收集（collectP2p 未开）", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(shouldPassiveCollect({ ...base, chatType: "p2p" } as never, passive as never)).toBe(
      false,
    );
  });

  it("私聊消息 + collectP2p → 收集，群白名单不限制私聊、发送者排除仍生效", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    const p2pMsg = { ...base, chatType: "p2p", chatId: "oc_p2p_chat" };
    const withP2p = { ...passive, collectP2p: true };
    expect(shouldPassiveCollect(p2pMsg as never, withP2p as never)).toBe(true);
    expect(
      shouldPassiveCollect(p2pMsg as never, { ...withP2p, chatIds: ["oc_other"] } as never),
    ).toBe(true);
    expect(
      shouldPassiveCollect(
        { ...p2pMsg, senderId: "ou_bot_a" } as never,
        { ...withP2p, excludeSenderIds: ["ou_bot_a"] } as never,
      ),
    ).toBe(false);
  });

  it("chatIds 白名单外 → 不收集", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect(base as never, { ...passive, chatIds: ["oc_other"] } as never),
    ).toBe(false);
  });

  it("发送者在 excludeSenderIds（机器人 open_id）→ 不收集（防回声）", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect(base as never, {
        ...passive,
        excludeSenderIds: ["ou_bot_a"],
      } as never),
    ).toBe(true);
    expect(
      shouldPassiveCollect(
        { ...base, senderId: "ou_bot_a" } as never,
        { ...passive, excludeSenderIds: ["ou_bot_a"] } as never,
      ),
    ).toBe(false);
  });

  it("空文本 → 不收集", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(shouldPassiveCollect({ ...base, content: "" } as never, passive as never)).toBe(false);
  });
});

// ── shouldProcessMessage — 免@指令群（mentionExemptChatIds） ─────────

describe("shouldProcessMessage — mentionExemptChatIds", () => {
  const base = {
    messageId: "om_9",
    chatId: "oc_robot",
    chatType: "group",
    senderId: "ou_human",
    content: "确认 1",
    mentionedBot: false,
  };
  const config = { appId: "a", appSecret: "s", mentionExemptChatIds: ["oc_robot"] };

  it("免@群里的消息 → 处理（核验指令不用 @机器人）", async () => {
    const { shouldProcessMessage } = await import("./feishu-ingress.js");
    expect(shouldProcessMessage(base as never, config as never)).toBe(true);
  });

  it("其他群的免@消息 → 过滤（原行为不变）", async () => {
    const { shouldProcessMessage } = await import("./feishu-ingress.js");
    expect(
      shouldProcessMessage({ ...base, chatId: "oc_other" } as never, config as never),
    ).toBe(false);
  });

  it("未配置免@群时行为不变（群消息需 @bot）", async () => {
    const { shouldProcessMessage } = await import("./feishu-ingress.js");
    expect(shouldProcessMessage(base as never, { appId: "a", appSecret: "s" } as never)).toBe(
      false,
    );
    expect(
      shouldProcessMessage({ ...base, mentionedBot: true } as never, {
        appId: "a",
        appSecret: "s",
      } as never),
    ).toBe(true);
  });
});

// ── 语音消息识别（audio content 占位串回归）─────────────────────────
// SDK 把语音消息归一化成 `<audio key="..." duration="..."/>` 占位串，
// 不识别的话它会被原样当 user_input 喂给角色层，意图正则全落空。

describe("isAudioContent — 语音占位串识别", () => {
  it("标准 audio XML 占位串", async () => {
    const { isAudioContent } = await import("./feishu-ingress.js");
    expect(isAudioContent('<audio key="file_v2_abc" duration="3200"/>')).toBe(true);
  });

  it("SDK file_key 缺失时的 [audio] 字面量", async () => {
    const { isAudioContent } = await import("./feishu-ingress.js");
    expect(isAudioContent("[audio]")).toBe(true);
  });

  it("普通文本不是语音", async () => {
    const { isAudioContent } = await import("./feishu-ingress.js");
    expect(isAudioContent("建任务：修复导出")).toBe(false);
    expect(isAudioContent("")).toBe(false);
  });

  it("不含 audio 的富文本不是语音", async () => {
    const { isAudioContent } = await import("./feishu-ingress.js");
    expect(isAudioContent("Audio 质量不错")).toBe(false);
  });
});

describe("audioContentDurationMs — 时长提取", () => {
  it("从占位串抠 duration", async () => {
    const { audioContentDurationMs } = await import("./feishu-ingress.js");
    expect(audioContentDurationMs('<audio key="k" duration="3200"/>')).toBe(3200);
  });

  it("缺失或非法返回 null", async () => {
    const { audioContentDurationMs } = await import("./feishu-ingress.js");
    expect(audioContentDurationMs('<audio key="k"/>')).toBeNull();
    expect(audioContentDurationMs('<audio key="k" duration="0"/>')).toBeNull();
    expect(audioContentDurationMs('<audio key="k" duration="abc"/>')).toBeNull();
  });
});

describe("firstAudioResource — 资源描述符提取", () => {
  it("命中 type=audio 的资源", async () => {
    const { firstAudioResource } = await import("./feishu-ingress.js");
    const msg = {
      resources: [
        { type: "file", fileKey: "f1" },
        { type: "audio", fileKey: "f2", durationMs: 1500 },
      ],
    };
    expect(firstAudioResource(msg as never)?.fileKey).toBe("f2");
  });

  it("无 audio 资源返回 null（不抛异常）", async () => {
    const { firstAudioResource } = await import("./feishu-ingress.js");
    expect(firstAudioResource({ resources: [] } as never)).toBeNull();
    expect(firstAudioResource({} as never)).toBeNull();
  });
});

describe("shouldPassiveCollect — 语音消息放行", () => {
  const asMsg = (over: Record<string, unknown>) => over as never;
  const passiveCfg = { enabled: true, onCollect: () => {} };

  it("语音消息（content 为占位串但有 audio 资源）→ 收集而非静默丢弃", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect(
        asMsg({
          chatType: "group",
          mentionedBot: false,
          chatId: "oc_x",
          senderId: "ou_u",
          content: '<audio key="k" duration="1200"/>',
          resources: [{ type: "audio", fileKey: "k" }],
        }),
        passiveCfg as never,
      ),
    ).toBe(true);
  });

  it("无文本且无 audio 资源 → 仍丢弃", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect(
        asMsg({
          chatType: "group",
          mentionedBot: false,
          chatId: "oc_x",
          senderId: "ou_u",
          content: "",
          resources: [],
        }),
        passiveCfg as never,
      ),
    ).toBe(false);
  });

  it("语音消息仍受 excludeSenderIds 防回声约束", async () => {
    const { shouldPassiveCollect } = await import("./feishu-ingress.js");
    expect(
      shouldPassiveCollect(
        asMsg({
          chatType: "group",
          mentionedBot: false,
          chatId: "oc_x",
          senderId: "ou_bot",
          content: '<audio key="k"/>',
          resources: [{ type: "audio", fileKey: "k" }],
        }),
        { ...passiveCfg, excludeSenderIds: ["ou_bot"] } as never,
      ),
    ).toBe(false);
  });
});
