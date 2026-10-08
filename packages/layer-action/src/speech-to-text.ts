/**
 * @aigility-harness/layer-action — 语音转文本能力（@action/speech-to-text）
 *
 * 契约：输入 PCM 16-bit 单声道音频 Buffer + 采样率，输出识别文本。
 * 归属 D3 行动域：模态工具族（STT/TTS、视觉、3D 形象）本体在行动域，
 * D5 人格域只声明与委托、不实现（README 五域表口径）。
 *
 * 两个 Provider 实现同一契约，运行时按配置切换：
 *   - `action-stt-vosk`    —— Vosk 离线识别器（复用本地模型，零网络）
 *   - `action-stt-whisper` —— transformers.js whisper（自动下载 ONNX 模型）
 *
 * 引擎均为「运行时可选依赖」：Provider 通过动态 import() 加载引擎，
 * 引擎未安装时 health() 返回 unhealthy，而非拖垮整个包。
 * 类型层不 import 引擎包——用本地最小接口描述，typecheck 零引擎依赖。
 */

import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

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
  id: "@action/speech-to-text",
  version: "1.0.0",
  layer: LayerId.Action,
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

/**
 * whisper 模型下载源（HuggingFace 镜像）。
 *
 * ── 这里修的是一个「照文档配了也没用」的陷阱 ──────────────────────
 *
 * 国内机器上 huggingface.co 常不可达，通行做法是设
 * `HF_ENDPOINT=https://hf-mirror.com`。**但 transformers.js v4 根本不读
 * HF_ENDPOINT**——它只认 `env.remoteHost`（默认恒为
 * "https://huggingface.co/"）。于是：
 *   用户设了 HF_ENDPOINT → 以为配好了 → 实际每次都在打不通的域名上
 *   超时 → 报一个与镜像毫无关系的错，排查方向被彻底带偏。
 *
 * 正确做法是在加载 pipeline 前直接改写 env.remoteHost。
 * 取值优先级（越靠前越优先）：
 *   1. WHISPER_REMOTE_HOST —— 本能力专用，语义最明确
 *   2. HF_ENDPOINT         —— 兼容用户既有习惯（同时也被其它 HF 工具读）
 *   3. hf-mirror.com       —— 默认走镜像（本机实测 huggingface.co 超时、
 *                             hf-mirror.com 200；直连可用的环境请显式设 1/2）
 */
export const WHISPER_REMOTE_HOST =
  process.env.WHISPER_REMOTE_HOST ??
  process.env.HF_ENDPOINT ??
  "https://hf-mirror.com";

/** 归一化为带尾斜杠的 remoteHost（transformers.js 拼接 remotePathTemplate 时依赖它） */
export function normalizeRemoteHost(host: string): string {
  const h = host.trim();
  if (!h) return "https://hf-mirror.com/";
  return h.endsWith("/") ? h : `${h}/`;
}

/**
 * 把镜像地址写进 transformers.js 的 env（在 pipeline 之前调用）。
 *
 * 之所以要「导出 + 单独可测」：真正的坑点是 remoteHost 的赋值时机与
 * 尾斜杠归一化，而不是 pipeline 调用本身——把这段独立出来就能在没有
 * 网络、不下载模型的单测里把回归钉死。
 *
 * @returns 实际生效的 remoteHost（带尾斜杠）
 */
export async function applyWhisperRemoteHost(): Promise<string> {
  const mod = (await loadWhisperModule()) as
    | { env?: { remoteHost?: string } }
    | null;
  const target = normalizeRemoteHost(WHISPER_REMOTE_HOST);
  if (mod?.env) mod.env.remoteHost = target;
  return target;
}

// ── 共享工具 ─────────────────────────────────────────────────────

/** PCM 16-bit Buffer → Float32Array（whisper 需要 float 输入） */
function pcm16ToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * vosk 输出规整：**合并中文词间空格**。
 *
 * vosk 的中文模型按词吐结果，词与词之间插空格：
 *   "今天 天气 不错 我们 开 个 会 吧"
 * 而中文书写不分词间空格。这份文本会直接进 LLM/人格层当 user_input
 * （意图正则如 /^建任务/、关键词匹配都会被空格打散），所以必须在
 * 能力边界上收敛，而不是指望每个下游各自清洗。
 *
 * 规则（保守，只动真正该动的地方）：
 *   - 仅当空格**两侧都是 CJK 字符**时删除该空格；
 *   - 中英混排（"今天 weather 不错"）保留空格——英文单词之间的空格是
 *     语义分隔，删掉会把两个词粘成一个不存在的词；
 *   - 连续多空格折叠（vosk 偶尔吐出）。
 *
 * @example
 *   normalizeVoskText("今天 天气 不错")   // "今天天气不错"
 *   normalizeVoskText("打开 api 文档")     // "打开 api 文档"（英文两侧保留）
 */
export function normalizeVoskText(raw: string): string {
  const collapsed = raw.replace(/[ \t\u3000]+/g, " ").trim();
  if (!collapsed) return "";
  // CJK 统一表意文字 + 扩展 A + 兼容表意 + 中文标点区
  const CJK = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF00-\\uFFEF";
  const re = new RegExp(`([${CJK}]) +([${CJK}])`, "g");
  let out = collapsed;
  // 反复替换：一次 replace 只能处理不重叠的相邻对（"a b c" 需要两轮）
  let prev: string;
  do {
    prev = out;
    out = out.replace(re, "$1$2");
  } while (out !== prev);
  return out.trim();
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
  name: "action-stt-vosk",
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
      const trimmed = normalizeVoskText(text);
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
  env?: { remoteHost?: string };
} | null> {
  try {
    const spec: string = "@huggingface/transformers";
    return (await import(spec)) as {
      pipeline: (task: string, model: string) => Promise<WhisperPipeline>;
      env?: { remoteHost?: string };
    };
  } catch {
    return null;
  }
}

/**
 * 模型是否已在本地缓存目录中（避免每次 execute 都去网上核对）。
 *
 * transformers.js 的缓存目录形如 `<cacheDir>/<org>/<model>/...`，
 * 存在即认为可离线加载；不存在则需联网下载（此时 remoteHost 生效）。
 */
export function whisperModelCacheDir(
  modelId: string,
  cacheRoot = process.env.HF_HOME ?? process.env.TRANSFORMERS_CACHE ?? `${process.env.HOME}/.cache/huggingface`,
): string {
  // modelId 形如 "Xenova/whisper-tiny" → 缓存按 org/model 两级目录存放
  return `${cacheRoot}/hub/${modelId.replace("/", "--")}`;
}

/** 加载 whisper 流水线（会触发第一次模型下载，仅 execute 调用） */
async function loadWhisper(): Promise<WhisperPipeline | null> {
  const mod = await loadWhisperModule();
  if (!mod) return null;
  try {
    // 必须在 pipeline() 之前改写——这正是 HF_ENDPOINT 失效的根因所在
    await applyWhisperRemoteHost();
    return await mod.pipeline("automatic-speech-recognition", WHISPER_MODEL_ID);
  } catch {
    return null;
  }
}

const whisperSttProvider: Provider<SpeechToTextRequest, SpeechToTextResponse> = {
  service: speechToTextService,
  name: "action-stt-whisper",
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
    const mod = await loadWhisperModule();
    if (!mod) {
      return {
        healthy: false,
        detail: "whisper 引擎未安装（缺 @huggingface/transformers）",
        checkedAt: new Date().toISOString(),
      };
    }
    // 真探测：包在 ≠ 能用。模型不在本地缓存时必须联网下载，
    // 而下载源（remoteHost）可达与否决定首次 execute 是成功还是挂死。
    // 这里只做「缓存命中 or 远端可达」二选一的轻量判断，不真的拉模型。
    const { stat } = await import("node:fs/promises");
    const cacheDir = whisperModelCacheDir(WHISPER_MODEL_ID);
    let cached = false;
    try {
      await stat(cacheDir);
      cached = true;
    } catch {
      /* 未缓存 */
    }
    if (cached) {
      return {
        healthy: true,
        detail: `whisper ASR ready（模型已缓存: ${cacheDir}）`,
        checkedAt: new Date().toISOString(),
      };
    }
    const host = normalizeRemoteHost(WHISPER_REMOTE_HOST);
    try {
      const r = await fetch(new URL("api/models", host).toString(), {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        healthy: r.ok || r.status === 404, // 404 也说明域名可达（模型路径才是真 404 点）
        detail: r.ok || r.status === 404
          ? `whisper ASR ready（模型未缓存，将经 ${host} 下载）`
          : `whisper 模型源不可用: ${host} → HTTP ${r.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        healthy: false,
        detail: `whisper 模型源不可达: ${host}（${(e as Error).message}）；可设 WHISPER_REMOTE_HOST 换源`,
        checkedAt: new Date().toISOString(),
      };
    }
  },
};

export {
  voskSttProvider,
  whisperSttProvider,
  VOSK_MODEL_PATH,
  WHISPER_MODEL_ID,
};