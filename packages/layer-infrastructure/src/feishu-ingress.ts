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
} from "@larksuiteoapi/node-sdk";

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

    const options: LarkChannelOptions = {
      appId,
      appSecret,
      transport: "websocket",
      source: "aigility-harness-feishu-ingress",
    };
    const channel = createLarkChannel(options);

    // 收消息 → 路由角色 → 回复
    activeUnsubscribe = channel.on({
      message: async (msg: NormalizedMessage) => {
        const text = messageText(msg);
        if (!text) return;

        // 路由：按会话来源 → 通配兜底
        const routeKey = msg.chatId || msg.senderId || "*";
        const roleId = agentRoutes[routeKey] ?? agentRoutes["*"] ?? perceptionId;

        try {
          // 调角色人格（与 http/wecom agent 链路同一载荷形状，附带用户 ID 记忆隔离）
          const result = await ctx.call(
            { id: roleId, versionRange: "^1.0.0" },
            {
              user_input: text,
              user_id: msg.senderId || "feishu-unknown",
            },
          );
          const finalText =
            (result.ok
              ? (result.value as { response?: string })?.response
              : "") || "抱歉，处理失败，请稍后重试或查看服务日志。";
          await channel.send(msg.chatId || msg.senderId, { text: finalText });
        } catch (e) {
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