/**
 * @aigility-arch/layer-action — 文本转语音能力
 *
 * @action/text-to-speech — 薄适配 msedge-tts（Microsoft Edge Read Aloud API）。
 *
 * 内化样板：源自 Open-LLM-VTuber 的 `tts/tts_interface.py` + `tts/edge_tts.py`。
 * Python 版用 `edge-tts`，这里用其 Node 等价包 `msedge-tts`（同一个上游 API），
 * 不复制源码，只做 Provider 薄适配。详见 internalize-oss-as-plugin skill。
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { LayerId, PluginState, ok, err } from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-arch/core";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

// ── 能力契约（从源接口 generate_audio(text) -> path 提炼）────────

export interface TextToSpeechRequest {
  /** 要合成的文本（非空） */
  text: string;
  /** 音色 ShortName，如 zh-CN-XiaoxiaoNeural；默认中文女声 */
  voice?: string;
  /** 语速：RATE 枚举 / 相对数(0.5) / 相对百分比(+50%) */
  rate?: string | number;
  /** 音调：PITCH 枚举 / +50Hz / +2st / +50% */
  pitch?: string;
  /** 音量：VOLUME 枚举 / 0–100 / +50 / +50% */
  volume?: string | number;
  /** 输出目录，默认系统临时目录 */
  outputDir?: string;
}

export interface TextToSpeechResponse {
  /** 生成的音频文件绝对路径 */
  audioFilePath: string;
  /** 字边界/句边界元数据文件（可能为空） */
  metadataFilePath: string | null;
  /** 实际使用的音色 */
  voice: string;
}

export const textToSpeechService: ServiceDefinition<
  TextToSpeechRequest,
  TextToSpeechResponse
> = {
  id: "@action/text-to-speech",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "文本转语音（Microsoft Edge Read Aloud，薄适配 msedge-tts npm 包）",
};

// ── Provider 实现 ────────────────────────────────────────────────

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

const msedgeTtsProvider: Provider<TextToSpeechRequest, TextToSpeechResponse> = {
  service: textToSpeechService,
  name: "action-text-to-speech-msedge",
  state: PluginState.Active,
  async execute(
    request: TextToSpeechRequest,
    ctx: SeamContext,
  ): Promise<Result<TextToSpeechResponse>> {
    const text = request.text?.trim();
    if (!text) {
      return err("text-to-speech: request.text is required and must be non-empty");
    }
    const voice = request.voice ?? DEFAULT_VOICE;
    const outputDir = request.outputDir ?? tmpdir();

    ctx.emit({
      type: "tts.synthesize",
      layer: LayerId.Action,
      payload: { voice, textLength: text.length },
      traceId: ctx.traceId,
    });

    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      await mkdir(outputDir, { recursive: true });
      const opts: Record<string, string | number> = {};
      if (request.rate !== undefined) opts.rate = request.rate;
      if (request.pitch !== undefined) opts.pitch = request.pitch;
      if (request.volume !== undefined) opts.volume = request.volume;
      const { audioFilePath, metadataFilePath } = await tts.toFile(
        outputDir,
        text,
        opts as Parameters<typeof tts.toFile>[2],
      );
      return ok({ audioFilePath, metadataFilePath, voice });
    } catch (e) {
      return err(`msedge-tts synthesize failed: ${String(e)}`);
    } finally {
      tts.close();
    }
  },
  async health(): Promise<HealthStatus> {
    // msedge-tts 是纯 HTTP/WS 客户端，无长驻连接；健康探针只做声明。
    return {
      healthy: true,
      detail: "msedge-tts ready (stateless client)",
      checkedAt: new Date().toISOString(),
    };
  },
};

/** 供 index.ts 注册到 LayerPlugin */
export const textToSpeechProvider: Provider<
  TextToSpeechRequest,
  TextToSpeechResponse
> = msedgeTtsProvider;