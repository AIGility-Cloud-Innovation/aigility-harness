/**
 * L1 底座层: Feishu Ingress — 飞书机器人通用入口 (gateway)
 *
 * 与 wecom-ingress / http-ingress 同构的「传输入口」：
 *   http-ingress  = HTTP 请求/响应 → 角色路由
 *   wecom-ingress = 企业微信 WebSocket 长连接 → 角色路由
 *   feishu-ingress = 飞书 WebSocket 长连接 → 角色路由（本文件）
 *
 * 设计（多机器人共用一个 ingress）:
 *   一个飞书 App（AppID+Secret）= 一个机器人实例 = 绑一个人格角色。
 *   多个机器人角色共用本 ingress 实现，通过配置（agentRoutes）识别决定
 *   路由到哪个角色人格。
 *
 * 用法:
 *   1. 飞书开放平台创建应用，拿到 App ID + App Secret
 *   2. 开启机器人能力；事件订阅选「长连接」模式（免公网回调）
 *   3. 配 .env: FEISHU_APP_ID=... FEISHU_APP_SECRET=...
 *   4. 装配角色 @persona/timem-project-assistant 等 → 收到消息即路由
 *
 * SDK: @larksuiteoapi/node-sdk（飞书官方）1.73.x 新式 LarkChannel API
 *   createLarkChannel({appId, appSecret, transport: 'websocket'})
 *   .connect() 自动认证/心跳/重连；.on({ message }) 收消息
 *   .im.message.reply / send 回消息
 */
import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
  err,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  CapabilityRef,
  HealthStatus,
} from "@aigility-harness/core";
import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
  ResourceDescriptor,
} from "@larksuiteoapi/node-sdk";

// ── 消费引用 ─────────────────────────────────────────────────────
// ── 消费引用 ─────────────────────────────────────────────────────

/** 消费项目任务助手人格（飞书「项目小助手」机器人默认角色） */
export const feishuTimemSupportRef: CapabilityRef = {
  id: "@persona/timem-project-assistant",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface FeishuIngressRequest {
  /** 飞书 App ID（开放平台获取；缺省读 FEISHU_APP_ID 环境变量） */
  appId?: string;
  /** 飞书 App Secret（开放平台获取；缺省读 FEISHU_APP_SECRET 环境变量） */
  appSecret?: string;
  /**
   * 消息 → 角色映射。识别键可选：会话来源（chatId / senderId）或
   * 未来的 App ID 多机器人。默认 { "*": "@persona/timem-project-assistant" }。
   */
  agentRoutes?: Record<string, string>;
  /** 兜底角色（未命中 agentRoutes 时，默认 @persona/timem-project-assistant） */
  perceptionId?: string;
  /** 处理中占位文案（暂未启用流式占位，保留字段） */
  thinkingText?: string;

  // ── 通用过滤配置（不含业务语义，纯消息层规则） ──
  /** 白名单会话 ID 列表；空数组或未设=不限制 */
  allowedConversationIds?: string[];
  /** 黑名单会话 ID 列表；命中则直接丢弃 */
  blockedConversationIds?: string[];
  /** 黑名单发送者 ID 列表；命中则直接丢弃 */
  blockedSenderIds?: string[];
  /** 关键词黑名单；content 包含任一关键词则丢弃 */
  keywordBlacklist?: string[];
}

export interface FeishuIngressResponse {
  ok: boolean;
  connected: boolean;
  appId: string;
  /** 断开连接函数 */
  stop: () => Promise<void>;
}

// ── 服务/清单 ────────────────────────────────────────────────────

export const feishuIngressService: ServiceDefinition<FeishuIngressRequest, FeishuIngressResponse> = {
  id: "@infrastructure/feishu-ingress",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "飞书机器人入口（WebSocket 长连接 → 角色路由）",
};

export const manifest: PluginManifest = {
  name: "@infrastructure/feishu",
  layer: LayerId.Infrastructure,
  description: "底座层：飞书入口（机器人 WebSocket 长连接 → 角色路由，多机器人共用）",
  version: "1.0.0",
  provides: [feishuIngressService],
  consumes: [feishuTimemSupportRef],
  preferredCarrier: CarrierKind.Thread,
};

// ── Provider 实现 ────────────────────────────────────────────────

let activeChannel: LarkChannel | null = null;
let activeUnsubscribe: (() => void) | null = null;
let activeStop: (() => Promise<void>) | null = null;

/** 从归一化消息提取纯文本正文（去掉 mention 等标记） */
function messageText(msg: NormalizedMessage): string {
  let text = msg.content ?? "";
  // 事件归一化后 content 可能是纯文本（text 消息）或富文本内容
  return text.trim();
}

/** 通用过滤器：按黑白名单/关键词/mention 规则判定是否处理消息 */
function shouldProcessMessage(
  msg: NormalizedMessage,
  config: FeishuIngressRequest,
): boolean {
  // 1. 会话白名单
  if (
    config.allowedConversationIds &&
    config.allowedConversationIds.length > 0 &&
    !config.allowedConversationIds.includes(msg.chatId)
  ) {
    return false;
  }
  // 2. 会话黑名单
  if (
    config.blockedConversationIds &&
    config.blockedConversationIds.includes(msg.chatId)
  ) {
    return false;
  }
  // 3. 发送者黑名单
  if (
    config.blockedSenderIds &&
    config.blockedSenderIds.includes(msg.senderId)
  ) {
    return false;
  }
  // 4. 关键词黑名单
  if (config.keywordBlacklist && config.keywordBlacklist.length > 0) {
    const content = msg.content?.toLowerCase() ?? "";
    if (
      config.keywordBlacklist.some((kw) =>
        content.includes(kw.toLowerCase()),
      )
    ) {
      return false;
    }
  }
  // 5. Trigger 判定：仅 p2p 或 group+@bot 才处理
  if (msg.chatType === "group" && !msg.mentionedBot) {
    return false;
  }
  // chatType 为 p2p 时 always process（不要求 @bot）
  // 其他 chatType（如 topic）静默丢弃
  if (msg.chatType !== "p2p" && msg.chatType !== "group") {
    return false;
  }
  return true;
}

/** 内存去重器：Map<messageId, timestamp> + TTL 5 分钟 */
class MessageDeduper {
  private seen = new Map<string, number>();
  private readonly ttlMs = 5 * 60 * 1000; // 5 分钟

  isDuplicate(messageId: string): boolean {
    const now = Date.now();
    const ts = this.seen.get(messageId);
    if (ts !== undefined) {
      if (now - ts < this.ttlMs) {
        return true; // 仍在 TTL 内，重复
      }
      // TTL 过期，清理旧条目
      this.seen.delete(messageId);
    }
    this.seen.set(messageId, now);
    // 定期清理过期条目（简单策略：每次插入时清理 10%）
    if (Math.random() < 0.1) {
      this.cleanup(now);
    }
    return false;
  }

  private cleanup(now: number) {
    for (const [id, ts] of this.seen.entries()) {
      if (now - ts >= this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }
}

/** 资源下载器：将 image 资源下载为 base64，失败不阻塞主流程 */
async function downloadResources(
  channel: LarkChannel,
  resources: ResourceDescriptor[],
): Promise<Array<{ type: string; data: string; fileName?: string }>> {
  const results: Array<{ type: string; data: string; fileName?: string }> = [];
  for (const res of resources) {
    if (res.type === "image") {
      try {
        const buffer = await channel.downloadResource(res.fileKey, "image");
        const base64 = buffer.toString("base64");
        results.push({
          type: "image",
          data: `data:image/png;base64,${base64}`, // 默认 png，实际类型可后续扩展
          fileName: res.fileName,
        });
      } catch (e) {
        console.warn(
          `[feishu-ingress] resource download failed: fileKey=${res.fileKey}`,
          e,
        );
        // 下载失败不阻塞，跳过该资源
      }
    }
    // 其他资源类型（file/audio/video）暂不处理，可按需扩展
  }
  return results;
}

const deduper = new MessageDeduper();

export const feishuIngressProvider: Provider<FeishuIngressRequest, FeishuIngressResponse> = {
  service: feishuIngressService,
  name: "infrastructure-feishu-ingress",
  state: PluginState.Active,
  async health(): Promise<HealthStatus> {
    return {
      healthy: activeChannel !== null,
      detail: activeChannel ? "Feishu channel created" : "Feishu channel not started",
      checkedAt: new Date().toISOString(),
    };
  },
  async execute(
    request: FeishuIngressRequest,
    ctx: SeamContext,
  ): Promise<Result<FeishuIngressResponse>> {
    // 若已启动则先停止（重新装配场景）
    if (activeStop) {
      await activeStop();
      activeStop = null;
    }

    const appId = request.appId ?? process.env["FEISHU_APP_ID"] ?? "";
    const appSecret = request.appSecret ?? process.env["FEISHU_APP_SECRET"] ?? "";

    if (!appId || !appSecret) {
      return err(
        "Feishu 凭证缺失: 需要 appId+appSecret（request 或 FEISHU_APP_ID/FEISHU_APP_SECRET 环境变量）",
      );
    }

    const agentRoutes = request.agentRoutes ?? { "*": "@persona/timem-project-assistant" };
    const perceptionId = request.perceptionId ?? "@persona/timem-project-assistant";
    const thinkingText = request.thinkingText ?? "正在处理中，请稍候…";

    const options: LarkChannelOptions = {
      appId,
      appSecret,
      transport: "websocket",
      source: "aigility-harness-feishu-ingress",
    };
    const channel = createLarkChannel(options);

    // 收消息 → 过滤/去重/资源下载 → 路由角色 → 回复
    activeUnsubscribe = channel.on({
      message: async (msg: NormalizedMessage) => {
        // 1. 通用过滤（黑白名单/关键词/trigger 判定）
        if (!shouldProcessMessage(msg, request)) {
          console.log(
            `[feishu-ingress] message filtered: chat=${msg.chatId} type=${msg.chatType} mentionedBot=${msg.mentionedBot}`,
          );
          return;
        }

        // 2. 去重：按 messageId 内存去重（TTL 5 分钟）
        if (deduper.isDuplicate(msg.messageId)) {
          console.log(
            `[feishu-ingress] duplicate message skipped: messageId=${msg.messageId}`,
          );
          return;
        }

        const text = messageText(msg);
        console.log(`[feishu-ingress] message received: chat=${msg.chatId} sender=${msg.senderId} text="${text}"`);
        if (!text) return;

        // 3. 资源下载（image → base64，失败不阻塞）
        const resources = await downloadResources(channel, msg.resources);

        // 路由：按会话来源 → 通配兜底
        const routeKey = msg.chatId || msg.senderId || "*";
        const roleId = agentRoutes[routeKey] ?? agentRoutes["*"] ?? perceptionId;

        try {
          // 两段式回复（方案 C，零权限）：
          // 1) 立即发占位消息「✍️ 正在处理…」（敲键盘提示）
          // 2) 处理完成 → 原地编辑成最终回复（一条消息变内容，无刷屏）
          const placeholder = await channel.send(msg.chatId || msg.senderId, {
            text: thinkingText,
          });
          let finalText = "抱歉，处理失败，请稍后重试或查看服务日志。";
          try {
            // ctx.call 人格请求：附带通用会话上下文字段
            // 注意：conversation_id/chat_type/resources 是通用字段，
            // 不含业务语义；persona 插件自行决定是否消费
            const result = await ctx.call(
              { id: roleId, versionRange: "^1.0.0" },
              {
                user_input: text,
                user_id: msg.senderId || "feishu-unknown",
                conversation_id: msg.chatId,
                chat_type: msg.chatType,
                resources: resources.length > 0 ? resources : undefined,
              },
            );
            if (result.ok) {
              finalText =
                (result.value as { response?: string })?.response ?? finalText;
            }
          } catch (e) {
            finalText = `处理异常: ${e instanceof Error ? e.message : String(e)}`;
          }
          try {
            await channel.editMessage(placeholder.messageId, finalText);
          } catch {
            // 编辑失败（罕见）→ 占位消息已在上方，直接补发最终内容
            await channel.send(msg.chatId || msg.senderId, { text: finalText });
          }
        } catch (e) {
          // 占位消息发送失败 → 直接发最终回复
          const errText = `处理异常: ${e instanceof Error ? e.message : String(e)}`;
          try {
            await channel.send(msg.chatId || msg.senderId, { text: errText });
          } catch {
            /* 回复失败忽略 */
          }
        }
      },
    });

    activeChannel = channel;
    activeStop = async () => {
      try {
        activeUnsubscribe?.();
        await channel.disconnect();
      } catch {
        /* 停止失败忽略 */
      }
      activeChannel = null;
      activeUnsubscribe = null;
    };

    // 启动长连接（connect 内部完成握手后才 resolve，自动重连）
    channel
      .connect()
      .then(() => {
        console.log(`[feishu-ingress] connected: appId=${appId}`);
      })
      .catch((e) => {
        console.error("[feishu-ingress] connect error:", String(e));
      });

    return ok({
      ok: true,
      connected: true,
      appId,
      stop: activeStop,
    });
  },
};