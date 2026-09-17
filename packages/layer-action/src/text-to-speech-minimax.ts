/**
 * @aigility-harness/layer-action — 文本转语音能力（MiniMax Speech 2.8 HD）
 *
 * @action/text-to-speech 的第二个 Provider：薄适配 MiniMax T2A v2 HTTP API。
 *
 * 与 msedge-tts Provider 共用同一契约（TextToSpeechRequest / TextToSpeechResponse），
 * 运行时由 Seam Registry 按健康探测与负载策略做热替换。
 *
 * 需要环境变量：
 *   MINIMAX_API_KEY  — MiniMax API Key（必填，缺则 health 返回 unhealthy）
 *   MINIMAX_BASE_URL — 可选，默认 https://api.minimax.io（国内可用 https://api.minimax.cn）
 *   MINIMAX_MODEL    — 可选，默认 speech-2.8-hd
 *   MINIMAX_VOICE_ID — 可选，默认 Chinese_warm_narrator（系统预置中文女声）
 *
 * 响应体中 data.audio 为 hex 编码的音频字节流，解码后落盘为 mp3 文件。
 */

import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  TextToSpeechRequest,
  TextToSpeechResponse,
} from "./text-to-speech.js";
import { textToSpeechService } from "./text-to-speech.js";

// ── 配置 ─────────────────────────────────────────────────────────

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";
const MINIMAX_BASE_URL =
  process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "speech-2.8-hd";
const DEFAULT_VOICE_ID =
  process.env.MINIMAX_VOICE_ID ?? "Chinese_warm_narrator";

const T2A_ENDPOINT = "/v1/t2a_v2";

// ── 工具函数 ──────────────────────────────────────────────────────

/** 将 MiniMax 返回的 hex 字符串解码为 Buffer */
function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * 将 TextToSpeechRequest 中的 rate/pitch/volume 归一化为 MiniMax 期望的数值：
 * - speed: 0.5–2.0，默认 1.0
 * - pitch: 0–100（中值 0，范围 -100 到 100），默认 0
 * - vol:   0–10，默认 1.0
 *
 * msedge-tts 用 "+50%" / "+2st" 等字符串形式，MiniMax 只接受数值。
 * 这里做宽松解析：纯数字直接用，含 % 的按比例折算，无法解析的忽略。
 */
function normalizeSpeed(
  rate: string | number | undefined,
): number | undefined {
  if (rate === undefined) return undefined;
  if (typeof rate === "number") return rate;
  const n = Number(rate);
  if (!Number.isNaN(n)) return n;
  const m = rate.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (m) {
    const pct = parseFloat(m[1]);
    return Math.max(0.5, Math.min(2.0, 1 + pct / 100));
  }
  return undefined;
}

function normalizePitch(
  pitch: string | number | undefined,
): number | undefined {
  if (pitch === undefined) return undefined;
  if (typeof pitch === "number") return pitch;
  const n = Number(pitch);
  if (!Number.isNaN(n)) return n;
  return undefined;
}

function normalizeVolume(
  volume: string | number | undefined,
): number | undefined {
  if (volume === undefined) return undefined;
  if (typeof volume === "number") {
    // msedge 用 0–100，MiniMax 用 0–10
    if (volume > 10) return volume / 10;
    return volume;
  }
  const n = Number(volume);
  if (!Number.isNaN(n)) {
    if (n > 10) return n / 10;
    return n;
  }
  return undefined;
}

// ── MiniMax API 请求/响应形状 ─────────────────────────────────────

interface MiniMaxT2ARequestBody {
  model: string;
  text: string;
  stream: boolean;
  voice_setting: {
    voice_id: string;
    speed?: number;
    vol?: number;
    pitch?: number;
  };
  audio_setting: {
    sample_rate: number;
    bitrate: number;
    format: string;
    channel: number;
  };
  language_boost?: string;
  output_format: string;
}

interface MiniMaxT2AResponse {
  data?: {
    audio?: string; // hex 编码
    status?: number;
  };
  extra_info?: {
    audio_length?: number;
    audio_sample_rate?: number;
    audio_size?: number;
    bitrate?: number;
    audio_format?: string;
    audio_channel?: number;
    usage_characters?: number;
  };
  trace_id?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

// ── Provider 实现 ────────────────────────────────────────────────

export const minimaxTtsProvider: Provider<
  TextToSpeechRequest,
  TextToSpeechResponse
> = {
  service: textToSpeechService,
  name: "action-text-to-speech-minimax",
  state: PluginState.Active,

  async execute(
    request: TextToSpeechRequest,
    ctx: SeamContext,
  ): Promise<Result<TextToSpeechResponse>> {
    if (!MINIMAX_API_KEY) {
      return err(
        "minimax-tts: MINIMAX_API_KEY 环境变量未设置，无法调用 T2A API",
      );
    }

    const text = request.text?.trim();
    if (!text) {
      return err("text-to-speech: request.text is required and must be non-empty");
    }

    const voiceId = request.voice ?? DEFAULT_VOICE_ID;
    const outputDir = request.outputDir ?? tmpdir();

    ctx.emit({
      type: "tts.synthesize",
      layer: LayerId.Action,
      payload: {
        provider: "minimax",
        voice: voiceId,
        model: MINIMAX_MODEL,
        textLength: text.length,
      },
      traceId: ctx.traceId,
    });

    // 构建 MiniMax 请求体
    const voiceSetting: Record<string, unknown> = { voice_id: voiceId };
    const speed = normalizeSpeed(request.rate);
    if (speed !== undefined) voiceSetting.speed = speed;
    const pitch = normalizePitch(request.pitch);
    if (pitch !== undefined) voiceSetting.pitch = pitch;
    const vol = normalizeVolume(request.volume);
    if (vol !== undefined) voiceSetting.vol = vol;

    const body: MiniMaxT2ARequestBody = {
      model: MINIMAX_MODEL,
      text,
      stream: false,
      voice_setting: voiceSetting as MiniMaxT2ARequestBody["voice_setting"],
      audio_setting: {
        sample_rate: 24000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
      language_boost: "auto",
      output_format: "hex",
    };

    try {
      const url = `${MINIMAX_BASE_URL}${T2A_ENDPOINT}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MINIMAX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return err(
          `minimax-tts HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        );
      }

      const json = (await resp.json()) as MiniMaxT2AResponse;

      // MiniMax 业务层错误码（HTTP 200 但 base_resp.status_code != 0）
      if (json.base_resp?.status_code !== 0) {
        return err(
          `minimax-tts 业务错误: ${json.base_resp?.status_msg ?? "unknown"} (code=${json.base_resp?.status_code ?? "n/a"}, trace=${json.trace_id ?? "n/a"})`,
        );
      }

      const hexAudio = json.data?.audio;
      if (!hexAudio) {
        return err(
          `minimax-tts 响应中缺少 data.audio 字段 (trace=${json.trace_id ?? "n/a"})`,
        );
      }

      const audioBuffer = hexToBuffer(hexAudio);
      await mkdir(outputDir, { recursive: true });
      const fileName = `tts-minimax-${randomUUID()}.mp3`;
      const audioFilePath = join(outputDir, fileName);
      await writeFile(audioFilePath, audioBuffer);

      return ok({
        audioFilePath,
        metadataFilePath: null,
        voice: voiceId,
      });
    } catch (e) {
      return err(`minimax-tts synthesize failed: ${String(e)}`);
    }
  },

  async health(): Promise<HealthStatus> {
    if (!MINIMAX_API_KEY) {
      return {
        healthy: false,
        detail:
          "minimax-tts 不可用：MINIMAX_API_KEY 未设置（其余 Provider 可继续服务）",
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      healthy: true,
      detail: `minimax-tts ready (model=${MINIMAX_MODEL}, voice=${DEFAULT_VOICE_ID})`,
      checkedAt: new Date().toISOString(),
    };
  },
};
