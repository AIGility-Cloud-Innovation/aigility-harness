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

// ── 首连退避参数（导出供测试断言） ───────────────────────────────
/** 线性退避基数：第 n 次失败等待 n × 该值 */
export const CONNECT_BACKOFF_BASE_MS = 10_000;
/** 退避封顶：超过后按固定间隔重试，避免无限拉长导致恢复延迟 */
export const CONNECT_BACKOFF_MAX_MS = 60_000;

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

  /**
   * 语音能力接线（TTS/STT）。不配则语音消息按旧行为只透传资源、
   * 不做转写（向后兼容：装配方不显式开启，行为完全不变）。
   */
  voice?: FeishuVoiceConfig;

  // ── 通用过滤配置（不含业务语义，纯消息层规则） ──
  /** 白名单会话 ID 列表；空数组或未设=不限制 */
  allowedConversationIds?: string[];
  /** 黑名单会话 ID 列表；命中则直接丢弃 */
  blockedConversationIds?: string[];
  /** 黑名单发送者 ID 列表；命中则直接丢弃 */
  blockedSenderIds?: string[];
  /** 关键词黑名单；content 包含任一关键词则丢弃 */
  keywordBlacklist?: string[];
  /**
   * 免@指令群：这些群里的免@消息也路由给角色（摘要播报群回复「确认 N」等
   * 核验指令不需要 @机器人）；角色侧按 mentioned_bot=false 只认指令、
   * 未命中保持静默。群消息处理走静默路径（不發「正在处理」占位）。
   */
  mentionExemptChatIds?: string[];

  // ── 监听模式（免 @bot 收集群聊消息，供编排层做汇总/判定） ──
  passive?: {
    enabled: boolean;
    /** 收集回调（不回复、不打扰群聊）；编排层用它把消息送入汇总缓冲 */
    onCollect: (m: {
      messageId: string;
      chatId: string;
      senderId: string;
      text: string;
      chatType: string;
      ts: number;
    }) => void;
    /** 只监听这些会话；空/未设 = 所有群 */
    chatIds?: string[];
    /**
     * 排除的发送者 open_id 列表（bot 自身/其他机器人）；命中则不收集。
     * 防回声：多机器人同群时，机器人间消息互喂汇总缓冲会形成循环。
     */
    excludeSenderIds?: string[];
    /**
     * 是否同时收集私聊（p2p）消息（默认否——历史上只收群聊）。
     * 开启后用户私聊发给机器人的文本也进汇总缓冲（如私聊报缺陷 → 机器人群摘要），
     * 且私聊仍走常规指令链路（交互回复与静默收集并行）；chatIds 群白名单对
     * 私聊不生效（白名单按群粒度管理），发送者排除仍生效。
     */
    collectP2p?: boolean;
  };
}

export interface FeishuIngressResponse {
  ok: boolean;
  connected: boolean;
  appId: string;
  /** 断开连接函数 */
  stop: () => Promise<void>;
  /** 主动发消息（供编排层做群播报，如任务汇总/PR 提醒）；返回消息 id（引用定位用） */
  send: (chatId: string, text: string) => Promise<string | void>;
  /**
   * 主动发语音消息（TTS → Opus → 飞书 audio 消息）；返回消息 id。
   * 未装配 voice.tts 时抛错（调用方应判空后再用）。
   */
  sendVoice?: (chatId: string, text: string) => Promise<string | void>;
}

/**
 * 语音收发配置。
 *
 * 为什么要显式开关而不是默认探测引擎：
 *   语音链路会**改变 user_input 的语义**（音频 → 转写文本），
 *   并且引入外部进程（ffmpeg）与模型下载。这类副作用不该在装配方
 *   毫不知情时发生——默认关闭，由 task-loop 这类明确的消费方开启。
 */
export interface FeishuVoiceConfig {
  /** 入站：语音消息 → STT 转写文本（作为 user_input 进角色链路） */
  stt?: {
    enabled: boolean;
    /** 转写语言提示（whisper 用），如 "zh"；vosk 忽略 */
    language?: string;
    /** 转写失败时的兜底文案；缺省则不回复（只留日志） */
    onErrorText?: string;
  };
  /** 出站：角色回复文本 → TTS → 语音消息 */
  tts?: {
    enabled: boolean;
    /** 音色 ShortName，默认交给 TTS Provider 决定（zh-CN-XiaoxiaoNeural） */
    voice?: string;
    /**
     * 发言触发模式：
     *   "always" —— 每条回复都发语音（默认）
     *   "prefix" —— 回复以 voicePrefix 开头时才发语音，否则发文本
     *               前缀会被剥离后送入 TTS（如 "语音：今天..."）
     */
    mode?: "always" | "prefix";
    /** mode="prefix" 时的触发前缀，默认 "语音：" */
    voicePrefix?: string;
    /** 超过该字符数的回复不发语音（TTS 长文本又慢又贵），默认 200 */
    maxChars?: number;
  };
}

/**
 * passive 收集判定（导出供单测）：仅群聊/私聊（p2p 需显式 collectP2p）、
 * 未 @bot、有文本、发送者不在排除列表（防机器人回声循环）；
 * 群聊还需会话在监听白名单（空=全部），私聊不走群白名单。
 */
export function shouldPassiveCollect(
  msg: NormalizedMessage,
  passive?: FeishuIngressRequest["passive"],
): boolean {
  if (!passive?.enabled || msg.mentionedBot) return false;
  if (msg.chatType !== "group" && msg.chatType !== "p2p") return false;
  const text = messageText(msg);
  // 语音消息的 content 是 `<audio .../>` 占位串而非文本；不做这层放行的话，
  // 免@群里的语音发言会被静默丢弃（连收集机会都没有）。
  const isVoice = isAudioContent(text) || firstAudioResource(msg) !== null;
  if (!text && !isVoice) return false;
  const excluded = passive.excludeSenderIds ?? [];
  if (msg.senderId && excluded.includes(msg.senderId)) return false;
  if (msg.chatType === "p2p") return passive.collectP2p === true;
  const ids = passive.chatIds;
  return !ids || ids.length === 0 || ids.includes(msg.chatId);
}

// ── 服务/清单 ────────────────────────────────────────────────────

export const feishuIngressService: ServiceDefinition<FeishuIngressRequest, FeishuIngressResponse> = {
  id: "@infrastructure/feishu-ingress",
  version: "1.1.0",
  layer: LayerId.Infrastructure,
  description: "飞书机器人入口（WebSocket 长连接 → 角色路由）",
};

export const manifest: PluginManifest = {
  name: "@infrastructure/feishu",
  layer: LayerId.Infrastructure,
  description: "底座层：飞书入口（机器人 WebSocket 长连接 → 角色路由，多机器人共用；行首 @mention 剥离）",
  version: "1.1.0",
  provides: [feishuIngressService],
  consumes: [feishuTimemSupportRef],
  preferredCarrier: CarrierKind.Thread,
};

// ── Provider 实现 ────────────────────────────────────────────────

let activeChannel: LarkChannel | null = null;
let activeUnsubscribe: (() => void) | null = null;
let activeStop: (() => Promise<void>) | null = null;

/**
 * 从归一化消息提取纯文本正文（导出供单测）。
 * 行首 @mention 剥离（仅限 @bot 触发的消息）：群聊 @bot 后行首带 mention
 * 前缀（bot 名或 @_user_N 占位符形态），不剥则 ^ 锚定的意图正则全军覆没、
 * 业务指令错落进 LLM 兜底（#1234 事件根因）。只剥行首一次——正文中间的
 * @仓库 片段是 extractRepoSpec 解析仓库的载体不能动；未 @bot 的被动收集
 * 路径不改写原文。
 */
export function messageText(msg: NormalizedMessage): string {
  let text = (msg.content ?? "").trim();
  // 事件归一化后 content 可能是纯文本（text 消息）或富文本内容
  if (msg.mentionedBot) {
    text = text.replace(/^@\S+\s*/, "");
  }
  return text.trim();
}

/**
 * 飞书语音消息在归一化后 content 形如 `<audio key="file_v2_xxx" duration="3200"/>`。
 * 这个 XML 串**不是用户说的话**——它是 SDK 的占位表示。若不识别，它会
 * 被原样当成 user_input 喂给角色层（人格看到一堆尖括号，意图正则全落空）。
 *
 * 同时兜住另一种形态：SDK 在 file_key 缺失时吐的 `[audio]` 字面量。
 */
export function isAudioContent(content: string): boolean {
  const c = (content ?? "").trim();
  return /^<audio\b/i.test(c) || c === "[audio]";
}

/** 从归一化消息中取出第一个 audio 资源（无则 null） */
export function firstAudioResource(msg: NormalizedMessage): ResourceDescriptor | null {
  return msg.resources?.find((r) => r.type === "audio") ?? null;
}

/**
 * 从 `<audio key="..." duration="..."/>` 里抠出 duration（毫秒）。
 * 飞书 audio 消息自带时长，能省一次解码探测；缺失返回 null。
 */
export function audioContentDurationMs(content: string): number | null {
  const m = (content ?? "").match(/<audio\b[^>]*\bduration="(\d+)"/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 通用过滤器：按黑白名单/关键词/mention 规则判定是否处理消息 */
export function shouldProcessMessage(
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
  // 5. Trigger 判定：仅 p2p 或 group（含话题群，msg 自带 rootId 区分话题）+@bot 才处理；
  //    mentionExemptChatIds 里的群例外——免@消息也处理（摘要播报群回复「确认 N」等
  //    指令不用 @；persona 侧按 mentioned_bot=false 走「仅指令」模式，未命中保持静默）
  if (msg.chatType === "group" && !msg.mentionedBot) {
    if (!(config.mentionExemptChatIds ?? []).includes(msg.chatId)) return false;
  }
  // chatType 为 p2p 时 always process（不要求 @bot）
  // 其他 chatType（未知类型）静默丢弃
  if (msg.chatType !== "p2p" && msg.chatType !== "group") {
    return false;
  }
  return true;
}

/** 话题锚定：群聊回复锚到话题串（rootId 优先，无 rootId 的普通群聊锚到触发消息本身）；p2p 不锚 */
export function threadAnchorFor(msg: {
  chatType: string;
  rootId?: string;
  messageId: string;
}): string | undefined {
  if (msg.chatType !== "group") return undefined;
  return msg.rootId ?? msg.messageId;
}

/** 话题群适配（2026-10-04）：锚定回复带 replyInThread——
 *  · 话题群：回复落在原话题内，不再每次新建话题；
 *  · 普通群：楼中楼回复（比引用更聚拢，上下文不散）。
 *  TASK_REPLY_IN_THREAD=0 恢复旧行为（仅引用、不进串）。 */
export function replyInThreadEnabled(): boolean {
  return !["0", "false", "off"].includes((process.env["TASK_REPLY_IN_THREAD"] ?? "1").toLowerCase());
}

export function anchorSendOptions(
  anchor: string | undefined,
): { replyTo: string; replyInThread?: boolean } | undefined {
  if (!anchor) return undefined;
  return replyInThreadEnabled() ? { replyTo: anchor, replyInThread: true } : { replyTo: anchor };
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

/** 将 SDK 下载接口返回的可读流聚合为 Buffer */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * 资源下载器：将 image 资源下载为 base64，失败不阻塞主流程。
 *
 * 必须走 messageResource（消息内资源）端点：im.v1.image.get 仅支持
 * 应用自己上传的图片，用户消息里的图片用它取会报 400 —— 需要
 * message_id + file_key 成对传给 im.v1.messageResource.get。
 *
 * 该端点同样支持音频（文档口径：「包括音频、视频、图片和文件」），
 * 所以语音消息走同一个 path，只是 params.type="audio"。
 * 注意 **不要** 用 channel.downloadResource()（SDK 便捷方法）——它内部
 * 走 im.v1.file.get，只认应用自己上传的文件，用户消息必 400。
 */
async function downloadResources(
  channel: LarkChannel,
  messageId: string,
  resources: ResourceDescriptor[],
  opts?: { includeAudio?: boolean },
): Promise<Array<{ type: string; data: string; fileName?: string }>> {
  const results: Array<{ type: string; data: string; fileName?: string }> = [];
  for (const res of resources) {
    const wanted =
      res.type === "image" || (res.type === "audio" && opts?.includeAudio === true);
    if (!wanted) continue;
    try {
      if (!messageId) {
        throw new Error("messageId 为空，无法走消息资源端点");
      }
      const resp = await channel.rawClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: res.fileKey },
        params: { type: res.type },
      });
      const buffer = await streamToBuffer(resp.getReadableStream());
      const base64 = buffer.toString("base64");
      results.push({
        type: res.type,
        data:
          res.type === "image"
            ? `data:image/png;base64,${base64}` // 默认 png，实际类型可后续扩展
            : base64, // 音频：原始字节 base64（后续转码为 PCM 再识别）
        fileName: res.fileName,
      });
    } catch (e) {
      console.warn(
        `[feishu-ingress] resource download failed: type=${res.type} fileKey=${res.fileKey}`,
        e,
      );
      // 下载失败不阻塞，跳过该资源
    }
  }
  // 其他资源类型（file/video）暂不处理，可按需扩展
  return results;
}

/**
 * 下载消息内的音频资源原始字节（Opus/OGG）。
 * 与 image 同走 messageResource 端点（见上），返回 null 表示失败（不抛）。
 */
async function downloadAudio(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
): Promise<Buffer | null> {
  try {
    if (!messageId) throw new Error("messageId 为空");
    const resp = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: "audio" },
    });
    const buf = await streamToBuffer(resp.getReadableStream());
    if (buf.length === 0) throw new Error("下载到 0 字节");
    return buf;
  } catch (e) {
    console.warn(`[feishu-ingress] audio download failed: fileKey=${fileKey}`, e);
    return null;
  }
}

/**
 * 语音入站转写：飞书 Opus → PCM 16k mono → STT → 文本。
 *
 * 三步缺一不可，每步都可能失败，所以逐段降级并给出可读日志：
 *   1. ffmpeg 转码（飞书语音是 Opus/OGG，两个 STT 引擎都只吃 PCM）
 *   2. @action/speech-to-text（内核按健康度选 provider，vosk 优先）
 *   3. 失败返回 null，由调用方决定是兜底文案还是不回复
 *
 * 为什么不直接给 STT 引擎喂 Opus：
 *   vosk 的 acceptWaveform 期待的是 PCM 裸流，喂 Ogg 容器会识别出
 *   乱码或空串；whisper 的 pipeline 同样只接受 Float32 采样序列。
 */
async function transcribeFeishuAudio(
  ctx: SeamContext,
  audioBytes: Buffer,
  cfg: NonNullable<FeishuVoiceConfig["stt"]>,
): Promise<{ text: string; engine: string } | null> {
  const t0 = Date.now();
  const tr = (await ctx.call(
    { id: "@action/audio-transcode", versionRange: "^1.0.0" },
    { audio: audioBytes, from: "opus", to: "pcm16", toSampleRate: 16000, toChannels: 1 },
  )) as {
    ok: boolean;
    value?: { audio: Buffer; sampleRate: number };
    error?: string;
  };
  if (!tr.ok || !tr.value) {
    console.warn(`[feishu-ingress] voice transcode failed: ${tr.error ?? "unknown"}`);
    return null;
  }

  const st = (await ctx.call(
    { id: "@action/speech-to-text", versionRange: "^1.0.0" },
    {
      audio: tr.value.audio,
      sampleRate: tr.value.sampleRate,
      ...(cfg.language ? { language: cfg.language } : {}),
    },
  )) as { ok: boolean; value?: { text: string; engine: string }; error?: string };
  if (!st.ok || !st.value?.text) {
    console.warn(`[feishu-ingress] voice STT failed: ${st.error ?? "empty text"}`);
    return null;
  }
  console.log(
    `[feishu-ingress] voice transcribed (${st.value.engine}, ${Date.now() - t0}ms): "${st.value.text.slice(0, 60)}"`,
  );
  return st.value;
}

const deduper = new MessageDeduper();

/**
 * 语音出站合成：回复文本 → TTS（MP3 落盘）→ ffmpeg 转 Opus/OGG。
 *
 * 为什么必须经 ffmpeg 中转而不能直接把 MP3 丢给飞书：
 *   飞书 audio 消息的 file_type 只认 opus（SDK 的 MediaUploader 对
 *   kind:"audio" 硬编码 uploadFile(buffer, "opus", ...)），MP3 上去
 *   会播放失败。而 msedge-tts 只会吐 MP3 —— 中间这一跳是刚需。
 *
 * 失败返回 null：语音是**增强**而非必需，TTS/转码挂了不能吞掉文本回复。
 */
async function synthesizeReplyVoice(
  ctx: SeamContext,
  text: string,
  cfg: NonNullable<FeishuVoiceConfig["tts"]>,
): Promise<{ opus: Buffer; durationMs?: number } | null> {
  try {
    const tts = (await ctx.call(
      { id: "@action/text-to-speech", versionRange: "^1.0.0" },
      { text, ...(cfg.voice ? { voice: cfg.voice } : {}) },
    )) as {
      ok: boolean;
      value?: { audioFilePath: string };
      error?: string;
    };
    if (!tts.ok || !tts.value?.audioFilePath) {
      console.warn(`[feishu-ingress] voice TTS failed: ${tts.error ?? "no file"}`);
      return null;
    }
    const { readFile } = await import("node:fs/promises");
    const mp3 = await readFile(tts.value.audioFilePath);

    const tr = (await ctx.call(
      { id: "@action/audio-transcode", versionRange: "^1.0.0" },
      { audio: mp3, from: "mp3", to: "opus" },
    )) as { ok: boolean; value?: { audio: Buffer; durationMs?: number }; error?: string };
    if (!tr.ok || !tr.value?.audio?.length) {
      console.warn(`[feishu-ingress] voice opus encode failed: ${tr.error ?? "empty"}`);
      return null;
    }
    return { opus: tr.value.audio, durationMs: tr.value.durationMs };
  } catch (e) {
    console.warn(`[feishu-ingress] voice synthesize error: ${String(e)}`);
    return null;
  }
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
    const thinkingText = request.thinkingText ?? "正在处理中，请稍候…";

    const options: LarkChannelOptions = {
      appId,
      appSecret,
      transport: "websocket",
      source: "aigility-harness-feishu-ingress",
      // PolicyGate 缺省 requireMention=true：免@群消息在 SDK 通道层就被以
      // no_mention 丢弃，永远到不了下面的 message 处理器 → passive 静默收集
      // 一次都不会触发（静默记录任务链路整体失效的根因）。
      // 开启 passive 时必须放开 mention 门槛；@bot 指令路由由本层
      // shouldProcessMessage/agentRoutes 自行判定，放权不影响指令链路。
      // @所有人(mentionAll) 仍维持默认拦截，防全员消息刷屏误触发。
      ...(request.passive?.enabled ? { policy: { requireMention: false } } : {}),
      // 长期治本：僵尸连接自愈
      // pingTimeout=秒级 liveness watchdog——超过窗口无入站消息判定死连接自动重连
      // （中间设备静默丢弃 WS 时 TCP 层不报错，此前只能靠人工重启）
      // handshakeTimeoutMs=握手超时，防 DNS/NAT 卡死
      wsConfig: { pingTimeout: 60 },
      handshakeTimeoutMs: 15_000,
    };
    const channel = createLarkChannel(options);

    /**
     * 语音装配前置校验：出站语音依赖 @action/audio-transcode（ffmpeg），
     * 它是**独立能力**——装配方可能只装了 STT 没装转码，或 ffmpeg 不在 PATH。
     * 提前探一次并置位错误标记，让「每条回复都 TTS 再到转码失败」退化
     * 成「启动时一条明确警告 + 文本链路照常」。
     */
    let voiceCfgError = false;
    if (request.voice?.tts?.enabled) {
      const h = (await ctx.call(
        { id: "@action/audio-transcode", versionRange: "^1.0.0" },
        { audio: Buffer.from([0]), to: "pcm16", timeoutMs: 5_000 },
      )) as { ok: boolean; error?: string };
      // 上面这次调用**必然失败**（1 字节 PCM 不足以成帧），我们只看它是
      // 「能力不存在」还是「能力存在但输入不合法」：后者说明装配正常。
      const capabilityMissing =
        typeof h.error === "string" && /未知|not found|no provider|未注册|unresolved/i.test(h.error);
      if (capabilityMissing) {
        voiceCfgError = true;
        console.warn(
          `[feishu-ingress] voice.tts 已开启但 @action/audio-transcode 不可用：${h.error}；语音回复已停用，文本链路不受影响`,
        );
      }
    }

    // 收消息 → 过滤/去重/资源下载 → 路由角色 → 回复
    activeUnsubscribe = channel.on({
      message: async (msg: NormalizedMessage) => {
        // 0. 监听模式：群聊未 @bot 的消息不回复，但按配置收集给编排层
        const passive = request.passive;
        const text0 = messageText(msg);
        if (
          passive !== undefined &&
          shouldPassiveCollect(msg, passive) &&
          !deduper.isDuplicate(`passive:${msg.messageId}`)
        ) {
          try {
            console.log(`[feishu-ingress] passive collect: chat=${msg.chatId} sender=${msg.senderId} text="${text0.slice(0, 50)}"`);
            passive.onCollect({
              messageId: msg.messageId,
              chatId: msg.chatId,
              senderId: msg.senderId,
              text: text0,
              chatType: msg.chatType,
              ts: Date.now(),
            });
          } catch (e) {
            console.log(`[feishu-ingress] passive collect error: ${String(e)}`);
          }
          // 收集后继续走常规过滤：若不满足 @bot 触发条件则到此为止
        }

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

        let text = messageText(msg);
        const isVoice = isAudioContent(text) || firstAudioResource(msg) !== null;
        // 语音消息：content 是 <audio .../> 占位串，需要先转写才有真正的 user_input
        let audioTranscribed = false;
        if (isVoice && request.voice?.stt?.enabled) {
          const audioRes = firstAudioResource(msg);
          if (audioRes?.fileKey) {
            const audioBytes = await downloadAudio(channel, msg.messageId, audioRes.fileKey);
            if (audioBytes) {
              const t = await transcribeFeishuAudio(ctx, audioBytes, request.voice.stt);
              if (t?.text) {
                text = t.text;
                audioTranscribed = true;
              }
            }
          } else {
            console.warn(`[feishu-ingress] voice message without fileKey: messageId=${msg.messageId}`);
          }
        } else if (isVoice) {
          console.log(
            `[feishu-ingress] voice received but voice.stt disabled (content="${text.slice(0, 40)}")`,
          );
        }
        console.log(`[feishu-ingress] message received: chat=${msg.chatId} sender=${msg.senderId} text="${text}"${isVoice ? " [voice]" : ""}`);
        if (!text || isAudioContent(text)) return; // 无文本且未转写成功 → 无从处理

        // 3. 资源下载（image → base64，失败不阻塞；语音已在上面处理过）
        const resources = await downloadResources(channel, msg.messageId, msg.resources);

        // 路由：按会话来源 → 通配兜底
        const routeKey = msg.chatId || msg.senderId || "*";
        const roleId = agentRoutes[routeKey] ?? agentRoutes["*"] ?? perceptionId;

        try {
          // 两段式回复（方案 C，零权限）：占位 + 原地编辑，已在群里被 @ 过不再重复；
          // 话题/回复场景：把回复锚到用户的话题串里（replyTo=话题根），p2p/普通群聊直发。
          // 免@指令群（mentionExemptChatIds）走静默路径：不發占位，角色返回空文本
          // （未命中指令）就什么都不发——群里的普通聊天不打扰
          const to = msg.chatId || msg.senderId;
          const threadAnchor = threadAnchorFor(msg);
          const quietCommand = msg.chatType === "group" && !msg.mentionedBot;
          if (quietCommand) {
            const r = (await ctx.call(
              { id: roleId, versionRange: "^1.0.0" },
              {
                user_input: text,
                user_id: msg.senderId || "feishu-unknown",
                session_id: msg.chatId,   // 短时记忆窗口按会话（群/私聊）分桶（2026-10-08 补——此前 persona 拿不到，记忆窗口整段失效）
                conversation_id: msg.chatId,
                message_id: msg.messageId,
                root_id: msg.rootId,
                chat_type: msg.chatType,
                mentioned_bot: false,
                resources: resources.length > 0 ? resources : undefined,
              },
            )) as { ok?: boolean; value?: { response?: string } };
            const reply = (r?.ok ? r.value?.response : "") ?? "";
            if (reply.trim()) {
              await channel.send(to, { text: reply }, anchorSendOptions(threadAnchor));
            }
            return;
          }
          // 1) 立即发占位消息「✍️ 正在处理…」（敲键盘提示）
          // 2) 处理完成 → 原地编辑成最终回复（一条消息变内容，无刷屏）
          const placeholder = await channel.send(to, { text: thinkingText }, anchorSendOptions(threadAnchor));
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
                session_id: msg.chatId,   // 短时记忆窗口按会话（群/私聊）分桶（2026-10-08 补）
                conversation_id: msg.chatId,
                message_id: msg.messageId,
                root_id: msg.rootId,
                chat_type: msg.chatType,
                mentioned_bot: msg.mentionedBot,
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
          // 语音出站：命中触发模式 → TTS + Opus + 发 audio 消息（文本照发，语音是增强）
          let voiceSent = false;
          if (request.voice?.tts?.enabled && !voiceCfgError) {
            const ttsCfg = request.voice.tts;
            const prefix = ttsCfg.voicePrefix ?? "语音：";
            const mode = ttsCfg.mode ?? "always";
            const maxChars = ttsCfg.maxChars ?? 200;
            const wantsVoice =
              mode === "always" ? true : finalText.startsWith(prefix);
            const speakText =
              mode === "prefix" && finalText.startsWith(prefix)
                ? finalText.slice(prefix.length).trim()
                : finalText;
            if (wantsVoice && speakText.length > 0 && speakText.length <= maxChars) {
              const voice = await synthesizeReplyVoice(ctx, speakText, ttsCfg);
              if (voice) {
                try {
                  await channel.send(
                    to,
                    {
                      audio: {
                        source: voice.opus,
                        ...(voice.durationMs ? { duration: voice.durationMs } : {}),
                      },
                    },
                    anchorSendOptions(threadAnchor),
                  );
                  voiceSent = true;
                } catch (e) {
                  console.warn(`[feishu-ingress] voice send failed: ${String(e)}`);
                }
              }
            }
          }
          try {
            await channel.editMessage(placeholder.messageId, finalText);
          } catch {
            // 编辑失败（罕见）→ 占位消息已在话题串里，直接补发最终内容（同样锚定话题）
            await channel.send(to, { text: finalText }, anchorSendOptions(threadAnchor));
          }
          if (voiceSent) console.log(`[feishu-ingress] voice reply sent: chat=${to} chars=${finalText.length}`);
        } catch (e) {
          // 占位消息发送失败 → 直接发最终回复
          const errText = `处理异常: ${e instanceof Error ? e.message : String(e)}`;
          console.log(`[feishu-ingress] placeholder send error: ${errText}`);
          try {
            await channel.send(msg.chatId || msg.senderId, { text: errText });
          } catch (e2) {
            /* 回复失败忽略 */
            console.log(`[feishu-ingress] fallback send error: ${e2 instanceof Error ? e2.message : String(e2)}`);
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

    // 启动长连接（connect 内部完成握手后才 resolve，自动重连）。
    // 首连失败（如 bot/v3/info 身份解析遇瞬时网络错误）会让通道静默死亡——
    // 进程还活着、单实例锁还持有，但机器人再也不响应，只能人工重启。
    // 因此这里持续退避重试（不设上限）：退避封顶后按固定间隔重试，
    // 与 connect() 内部的重连语义对齐；stop() 通过 activeStop 断开即可退出。
    const connectWithRetry = async (): Promise<void> => {
      let attempt = 0;
      while (activeChannel === channel) {
        attempt += 1;
        try {
          await channel.connect();
          console.log(`[feishu-ingress] connected: appId=${appId}`);
          return;
        } catch (e) {
          const delayMs = Math.min(CONNECT_BACKOFF_BASE_MS * attempt, CONNECT_BACKOFF_MAX_MS);
          console.error(
            `[feishu-ingress] connect error (第${attempt}次，${Math.round(delayMs / 1000)}s 后重试):`,
            String(e),
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      console.log(`[feishu-ingress] stop 已请求，停止重连 (appId=${appId})`);
    };
    void connectWithRetry();

    return ok({
      ok: true,
      connected: true,
      appId,
      stop: activeStop,
      send: async (chatId: string, text: string) => {
        const sent = await channel.send(chatId, { text });
        return sent?.messageId;
      },
      sendVoice: async (chatId: string, text: string) => {
        const ttsCfg = request.voice?.tts;
        if (!ttsCfg?.enabled) {
          throw new Error("sendVoice: 未装配 voice.tts（ingress request 里开启后可用）");
        }
        const voice = await synthesizeReplyVoice(ctx, text, ttsCfg);
        if (!voice) throw new Error("sendVoice: 合成失败（详见服务日志）");
        const sent = await channel.send(chatId, {
          audio: {
            source: voice.opus,
            ...(voice.durationMs ? { duration: voice.durationMs } : {}),
          },
        });
        return sent?.messageId;
      },
    });
  },
};