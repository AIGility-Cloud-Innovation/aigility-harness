/**
 * @aigility-arch/layer-perception — 语音转文本能力（@perception/speech-to-text）
 *
 * 契约：输入 PCM 16-bit 单声道音频 Buffer + 采样率，输出识别文本。
 * 音频是「外部信号摄入系统」的过程，故归属 Perception 层（感官层）。
 *
 * 两个 Provider 实现同一契约，运行时按配置切换：
 *   - `perception-stt-vosk`    —— Vosk 离线识别器（复用本地模型，零网络）
 *   - `perception-stt-whisper` —— transformers.js whisper（自动下载 ONNX 模型）
 *
 * 引擎均为「运行时可选依赖」：Provider 通过动态 import() 加载引擎，
 * 引擎未安装时 health() 返回 unhealthy，而非拖垮整个包。
 * 类型层不 import 引擎包——用本地最小接口描述，typecheck 零引擎依赖。
 */

import { LayerId, PluginState, ok, err } from "@aigility-arch/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-arch/core";

// ── 契约类型 ─────────────────────────────────────────────────────

export interface SpeechToTextRequest {
  /** PCM 16-bit 单声道原始音频（非 WAV 封装） */
  audio: Buffer;
  /** 采样率，默认 16000（vosk 与 whisper 模型均训练于 16kHz） */
  sampleRate?: number;
  /** 可选语言提示（whisper 用），如 "zh" / "en" */
  language?: string;
}

export interface SpeechToTextResponse {
  /** 识别出的文本 */
  text: string;
  /** 实际使用的引擎标识 */
  engine: "vosk" | "whisper";
  /** 可选：整体置信度（0–1），引擎未提供时省略 */
  confidence?: number;
}

export const speechToTextService: ServiceDefinition<
  SpeechToTextRequest,
  SpeechToTextResponse
> = {
  id: "@perception/speech-to-text",
  version: "1.0.0",
  layer: LayerId.Perception,
  description: "语音转文本（ASR）：PCM 音频 → 文本",
  requestSchema: {
    type: "object",
    required: ["audio"],
    properties: {
      audio: { description: "PCM 16-bit 单声道音频 Buffer" },
      sampleRate: { type: "number", default: 16000 },
      language: { type: "string" },
    },
  },
  responseSchema: {
    type: "object",
    required: ["text", "engine"],
    properties: {
      text: { type: "string" },
      engine: { enum: ["vosk", "whisper"] },
      confidence: { type: "number" },
    },
  },
};

// ── 本地最小引擎接口（不 import 引擎包）─────────────────────────

/** vosk 模型实例 */
interface VoskModel {
  free(): void;
}
/** vosk 识别器实例 */
interface VoskRecognizer {
  acceptWaveform(data: Buffer): boolean;
  result(): { text?: string };
  finalResult(): { text?: string };
  free(): void;
}
/** vosk npm 包的运行时形状 */
interface VoskModule {
  setLogLevel(level: number): void;
  Model: new (modelPath: string) => VoskModel;
  Recognizer: new (param: { model: VoskModel; sampleRate: number }) => VoskRecognizer;
}

/** whisper 流水线函数 */
type WhisperPipeline = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<{ text?: string }>;

// ── 引擎配置 ─────────────────────────────────────────────────────

/** vosk 模型目录，可通过环境变量覆盖（默认复用本地已下载的中文小模型） */
const VOSK_MODEL_PATH =
  process.env.VOSK_MODEL_PATH ??
  process.env.HOME + "/.local/share/vosk/models/vosk-model-small-cn-0.22";

/** whisper 模型 id，默认 whisper-tiny（约 39MB ONNX，零 GPU 可跑） */
const WHISPER_MODEL_ID = process.env.WHISPER_MODEL ?? "Xenova/whisper-tiny";

// ── 共享工具 ─────────────────────────────────────────────────────

/** PCM 16-bit Buffer → Float32Array（whisper 需要 float 输入） */
function pcm16ToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

// ── Vosk Provider（离线，复用本地模型）───────────────────────────

async function loadVosk(): Promise<VoskModule | null> {
  try {
    const spec: string = "vosk";
    const mod = (await import(spec)) as VoskModule;
    return mod;
  } catch {
    return null;
  }
}

const voskSttProvider: Provider<SpeechToTextRequest, SpeechToTextResponse> = {
  service: speechToTextService,
  name: "perception-stt-vosk",
  state: PluginState.Active,
  async execute(
    request: SpeechToTextRequest,
    _ctx: SeamContext,
  ): Promise<Result<SpeechToTextResponse>> {
    const vosk = await loadVosk();
    if (!vosk) return err("vosk 引擎不可用：请安装 vosk npm 包及其 libvosk");

    const sampleRate = request.sampleRate ?? 16000;
    let model: VoskModel;
    let recognizer: VoskRecognizer;
    try {
      vosk.setLogLevel(-1);
      model = new vosk.Model(VOSK_MODEL_PATH);
      recognizer = new vosk.Recognizer({ model, sampleRate });
    } catch (e) {
      return err(`vosk 模型加载失败: ${(e as Error).message}`);
    }

    try {
      const endOfSpeech = recognizer.acceptWaveform(request.audio);
      const finalText = recognizer.finalResult().text ?? "";
      let text = finalText;
      if (endOfSpeech) {
        const rText = recognizer.result().text;
        if (rText) text = rText;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        return err("vosk 未识别到语音（可能是静音或音频格式不符）");
      }
      return ok({ text: trimmed, engine: "vosk" });
    } finally {
      recognizer.free();
      model.free();
    }
  },
  async health(): Promise<HealthStatus> {
    const available = (await loadVosk()) !== null;
    return {
      healthy: available,
      detail: available
        ? "vosk ASR ready"
        : "vosk 引擎未安装（缺 vosk / libvosk）",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── Whisper Provider（默认，自动下载模型）────────────────────────

/** 仅加载 transformers 模块（不触发模型下载，供 health 快速探测） */
async function loadWhisperModule(): Promise<{
  pipeline: (task: string, model: string) => Promise<WhisperPipeline>;
} | null> {
  try {
    const spec: string = "@huggingface/transformers";
    return (await import(spec)) as {
      pipeline: (task: string, model: string) => Promise<WhisperPipeline>;
    };
  } catch {
    return null;
  }
}

/** 加载 whisper 流水线（会触发第一次模型下载，仅 execute 调用） */
async function loadWhisper(): Promise<WhisperPipeline | null> {
  const mod = await loadWhisperModule();
  if (!mod) return null;
  try {
    return await mod.pipeline("automatic-speech-recognition", WHISPER_MODEL_ID);
  } catch {
    return null;
  }
}

const whisperSttProvider: Provider<SpeechToTextRequest, SpeechToTextResponse> = {
  service: speechToTextService,
  name: "perception-stt-whisper",
  state: PluginState.Active,
  async execute(
    request: SpeechToTextRequest,
    _ctx: SeamContext,
  ): Promise<Result<SpeechToTextResponse>> {
    const transcriber = await loadWhisper();
    if (!transcriber) {
      return err(
        "whisper 引擎不可用：请安装 @huggingface/transformers + onnxruntime-node",
      );
    }
    try {
      const audio = pcm16ToFloat32(request.audio);
      const options: Record<string, unknown> = {};
      if (request.language) options.language = request.language;
      const out = await transcriber(audio, options);
      const text = (out?.text ?? "").trim();
      if (!text) return err("whisper 未识别到语音");
      return ok({ text, engine: "whisper" });
    } catch (e) {
      return err(`whisper 识别失败: ${(e as Error).message}`);
    }
  },
  async health(): Promise<HealthStatus> {
    const available = (await loadWhisperModule()) !== null;
    return {
      healthy: available,
      detail: available
        ? "whisper ASR ready"
        : "whisper 引擎未安装（缺 @huggingface/transformers）",
      checkedAt: new Date().toISOString(),
    };
  },
};

export {
  voskSttProvider,
  whisperSttProvider,
  VOSK_MODEL_PATH,
  WHISPER_MODEL_ID,
};