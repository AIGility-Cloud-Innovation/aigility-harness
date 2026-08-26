/**
 * L5 底座层: WeCom Ingress — 企业微信智能机器人入口 (特色案例)
 *
 * 与 http-ingress 同构的「传输入口」：
 *   http-ingress  = HTTP 请求/响应 → 角色路由
 *   wecom-ingress = 企业微信 WebSocket 长连接 → 角色路由
 *
 * 用法（特色案例: 企业微信里 @机器人 就能驱动 codex 干活）:
 *   1. 企微后台创建「智能机器人」，拿到 botId + secret
 *   2. 配 .env: WECOM_BOT_ID=... WECOM_BOT_SECRET=...
 *   3. 装配 plugin-helper... 角色@persona/coder → @orchestration/codex-agent → codex
 *
 * SDK: @wecom/aibot-node-sdk（企业微信官方 AI Bot SDK）
 *   wss://openws.work.weixin.qq.com 内置默认地址，自动认证/心跳/重连
 *
 * 设计:
 *   - 收到 message.text → 按 agentRoutes（默认 /@persona/coder）调角色
 *   - 复用角色的标准请求载荷 { user_input }，与 http-ingress agent 链路一致
 *   - 流式占位（"正在处理…"）→ 拿到最终结果 → replyStream 发回企微
 *   - 未认证/断开由 SDK 内部处理（指数退避重连）
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
import AiBot from "@wecom/aibot-node-sdk";
import type { WsFrame, TextMessage } from "@wecom/aibot-node-sdk";

// ── 消费引用 ─────────────────────────────────────────────────────

/** 消费编码助手角色能力（编码对话链路） */
export const wecomCoderRef: CapabilityRef = {
  id: "@persona/coder",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface WeComIngressRequest {
  /** 机器人 BotID（企微后台获取；缺省读 WECOM_BOT_ID 环境变量） */
  botId?: string;
  /** 机器人 Secret（企微后台获取；缺省读 WECOM_BOT_SECRET 环境变量） */
  secret?: string;
  /** 自定义 WebSocket 地址（默认 wss://openws.work.weixin.qq.com） */
  wsUrl?: string;
  /** 消息 → 角色映射（默认 { "*": "@persona/coder" }，全部走编码助手） */
  agentRoutes?: Record<string, string>;
  /** 兜底角色（未命中 agentRoutes 时，默认 @persona/coder） */
  perceptionId?: string;
  /** 流式占位文案（"正在处理…"） */
  thinkingText?: string;
}

export interface WeComIngressResponse {
  ok: boolean;
  connected: boolean;
  botId: string;
  /** 断开连接函数 */
  stop: () => Promise<void>;
}

// ── 服务/清单 ────────────────────────────────────────────────────

export const wecomIngressService: ServiceDefinition<WeComIngressRequest, WeComIngressResponse> = {
  id: "@infrastructure/wecom-ingress",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "企业微信智能机器人入口（WebSocket 长连接 → 角色路由，特色案例）",
};

export const manifest: PluginManifest = {
  name: "@infrastructure/wecom",
  layer: LayerId.Infrastructure,
  description: "底座层：企业微信入口（智能机器人 WebSocket 长连接 → 角色路由）",
  version: "1.0.0",
  provides: [wecomIngressService],
  consumes: [wecomCoderRef],
  preferredCarrier: CarrierKind.Thread,
};

// ── Provider 实现 ────────────────────────────────────────────────

let activeClient: AiBot.WSClient | null = null;
let activeStop: (() => Promise<void>) | null = null;

export const wecomIngressProvider: Provider<WeComIngressRequest, WeComIngressResponse> = {
  service: wecomIngressService,
  name: "infrastructure-wecom-ingress",
  state: PluginState.Active,
  async health(): Promise<HealthStatus> {
    return {
      healthy: activeClient?.isConnected ?? false,
      detail: activeClient?.isConnected
        ? "WeCom WebSocket connected"
        : "WeCom WebSocket not connected",
      checkedAt: new Date().toISOString(),
    };
  },
  async execute(
    request: WeComIngressRequest,
    ctx: SeamContext,
  ): Promise<Result<WeComIngressResponse>> {
    // 若已连接则先断开（重新装配场景）
    if (activeStop) {
      await activeStop();
      activeStop = null;
    }

    const botId =
      request.botId ?? process.env["WECOM_BOT_ID"] ?? "";
    const secret =
      request.secret ?? process.env["WECOM_BOT_SECRET"] ?? "";

    if (!botId || !secret) {
      return err(
        "WeCom 凭证缺失: 需要 botId+secret（request 或 WECOM_BOT_ID/WECOM_BOT_SECRET 环境变量）",
      );
    }

    const agentRoutes = request.agentRoutes ?? { "*": "@persona/coder" };
    const perceptionId = request.perceptionId ?? "@persona/coder";
    const thinkingText = request.thinkingText ?? "正在处理中，请稍候…";

    const client = new AiBot.WSClient({
      botId,
      secret,
      ...(request.wsUrl ? { wsUrl: request.wsUrl } : {}),
    });

    // 收到文本消息: 路由到角色 → 回复企微
    client.on("message.text", async (frame: WsFrame<TextMessage>) => {
      const content = frame.body?.text?.content ?? "";
      const trimmed = content.trim();
      if (!trimmed) return;

      const chatId = (frame.body as { chatid?: string }).chatid;
      const roleId = agentRoutes[chatId ?? "*"] ?? agentRoutes["*"] ?? perceptionId;

      let streamId = "";
      try {
        // 1. 流式占位（立即回执，让用户知道在处理）
        streamId = AiBot.generateReqId ? AiBot.generateReqId("stream") : `stream_${Date.now()}`;
        await client.replyStream(frame, streamId, thinkingText, false);

        // 2. 调角色（与 http-ingress agent 链路同一载荷形状）
        const result = await ctx.call(
          { id: roleId, versionRange: "^1.0.0" },
          { user_input: trimmed },
        );

        // 3. 最终回复（支持 Markdown: codex 输出通常带代码块）
        const finalText =
          (result.ok
            ? (result.value as { response?: string })?.response
            : "") || "抱歉，处理失败，请稍后重试或查看服务日志。";
        await client.replyStream(frame, streamId, finalText, true);
      } catch (e) {
        await client.replyStream(
          frame,
          streamId,
          `处理异常: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
    });

    client.on("authenticated", () => {
      console.log("[wecom-ingress] 认证成功: botId=", botId);
    });
    client.on("connected", () => {
      console.log("[wecom-ingress] WebSocket 已连接");
    });
    client.on("disconnected", (reason: unknown) => {
      console.log("[wecom-ingress] 连接断开: ", String(reason));
    });

    client.connect();
    activeClient = client;
    activeStop = async () => {
      client.disconnect();
      activeClient = null;
    };

    return ok({
      ok: true,
      connected: client.isConnected ?? false,
      botId,
      stop: activeStop,
    });
  },
};