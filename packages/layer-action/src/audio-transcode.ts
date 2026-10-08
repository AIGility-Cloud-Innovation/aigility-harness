/**
 * @aigility-harness/layer-action — 音频转码能力（@action/audio-transcode）
 *
 * 为什么需要这一层（而不是让 STT/TTS 各自处理格式）：
 *
 *   1. 飞书语音消息的真实编码是 **Opus/OGG**（应用侧上传语音也必须是
 *      file_type=opus），而两个 STT 引擎（vosk / whisper）吃的都是
 *      **PCM 16-bit 单声道**；TTS（msedge-tts）吐出的是 **MP3**。
 *      收发两端与识别引擎之间各差一次转码，且方向相反。
 *
 *   2. 转码是纯粹的「格式搬运」，不含业务语义。放在合约边界上做成独立
 *      能力，STT/TTS 契约就能保持「只谈 PCM / 只谈文本」的干净形态——
 *      否则每个引擎都要各自长出 opus/mp3/wav 解析分支。
 *
 *   3. 引擎是可替换的（faster-whisper 需 16k mono、vosk 需 16k mono、
 *      未来可能接云 ASR 需 8k），把采样率/声道收敛在这一层，
 *      换引擎时调用方零改动。
 *
 * 实现走 **ffmpeg 子进程**（本机已装，含 libopus 编码器）：
 *   - 不引入 native 依赖（@discordjs/opus 等需编译工具链）；
 *   - ffmpeg 是这套格式矩阵里唯一「什么都认、什么都吐」的工具；
 *   - 用 spawn + stdin/stdout 管道传数据，不落中间文件（无临时文件泄漏、
 *     无进程间文件竞争）。
 *
 * 引擎均为「运行时可选依赖」：ffmpeg 不在 PATH 时 health() 返回 unhealthy
 * 并附带安装指引，而不是拖垮整个包。
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 契约类型 ─────────────────────────────────────────────────────

/** 转码目标格式（STT 侧）或源格式（TTS 侧） */
export type AudioFormat = "pcm16" | "opus" | "mp3" | "wav";

export interface AudioTranscodeRequest {
  /** 输入音频字节（任意 ffmpeg 能探测的容器/裸流） */
  audio: Buffer;
  /**
   * 输入格式提示。
   *   - "pcm16" 必须显式给出（裸流无容器头，ffmpeg 无法自行探测）
   *   - 其余容器格式（opus/mp3/wav）留空即可，ffmpeg 自动探测
   */
  from?: AudioFormat;
  /** 目标格式，默认 pcm16（喂 STT 的常见需求） */
  to: AudioFormat;
  /** 输入采样率，仅 from="pcm16" 时需要，默认 16000 */
  fromSampleRate?: number;
  /** 输出采样率，默认：pcm16→16000（STT 训练采样率）；opus/mp3→24000 */
  toSampleRate?: number;
  /** 输出声道数，默认 1（单声道，两个 STT 引擎都要求） */
  toChannels?: number;
  /** 转码超时毫秒，默认 60000 */
  timeoutMs?: number;
}

export interface AudioTranscodeResponse {
  /** 转码后的音频字节 */
  audio: Buffer;
  /** 实际输出格式 */
  format: AudioFormat;
  /** 实际输出采样率 */
  sampleRate: number;
  /** 实际输出声道数 */
  channels: number;
  /** 输出时长毫秒（可用时给出） */
  durationMs?: number;
}

export const audioTranscodeService: ServiceDefinition<
  AudioTranscodeRequest,
  AudioTranscodeResponse
> = {
  id: "@action/audio-transcode",
  version: "1.0.0",
  layer: LayerId.Action,
  description:
    "音频转码（ffmpeg）：飞书 Opus/OGG ↔ STT 所需 PCM 16-bit 单声道，TTS MP3 → 飞书语音 Opus",
  requestSchema: {
    type: "object",
    required: ["audio", "to"],
    properties: {
      audio: { description: "输入音频 Buffer" },
      from: { enum: ["pcm16", "opus", "mp3", "wav"] },
      to: { enum: ["pcm16", "opus", "mp3", "wav"] },
      fromSampleRate: { type: "number" },
      toSampleRate: { type: "number" },
      toChannels: { type: "number" },
    },
  },
  responseSchema: {
    type: "object",
    required: ["audio", "format", "sampleRate", "channels"],
    properties: {
      audio: { description: "转码后音频 Buffer" },
      format: { enum: ["pcm16", "opus", "mp3", "wav"] },
      sampleRate: { type: "number" },
      channels: { type: "number" },
      durationMs: { type: "number" },
    },
  },
};

// ── 纯函数（导出供测试）─────────────────────────────────────────

/**
 * ffmpeg 可执行文件路径，可用 FFMPEG_PATH 覆盖（本机 ~/.local/bin/ffmpeg）。
 *
 * 必须是**函数**而不是模块级常量：消费方（feishu-task-loop 等）在
 * import 本模块**之后**才执行 loadEnv()，常量会在 .env 加载前就固化，
 * 导致 FFMPEG_PATH 永远读不到——这是典型的「配置时序」陷阱。
 */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

/** 各目标格式的默认采样率 */
export function defaultSampleRate(to: AudioFormat): number {
  // PCM 一律 16k：vosk 与 whisper 模型均训练于 16kHz，给别的采样率会显著掉准
  // Opus 内部统一 48k 是编解码器规范（飞书语音也按 48k 处理）
  return to === "pcm16" ? 16000 : to === "opus" ? 48000 : 24000;
}

/**
 * 组装 ffmpeg 参数（导出供测试；不执行）。
 *
 * 关键取舍：
 *   - `-f s16le` 是裸 PCM 的容器名，没有它 ffmpeg 无法解析无头裸流；
 *   - `-ar/-ac` 放在输出侧（-i 之后）才是重采样指令，放在输入侧只是声明；
 *   - Opus 在 OGG 容器里必须 `-c:a libopus`，且 `-b:a 24k` 兼顾体积与清晰度
 *     （飞书语音消息普遍 ~24kbps）；
 *   - `-v error` 抑制横幅，避免把 ffmpeg 版本信息混进 stderr 干扰判错。
 */
export function buildFfmpegArgs(req: AudioTranscodeRequest): string[] {
  const to = req.to;
  const toRate = req.toSampleRate ?? defaultSampleRate(to);
  const toCh = req.toChannels ?? 1;

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];

  // 输入：裸 PCM 需显式声明容器/采样率/声道
  if (req.from === "pcm16") {
    args.push(
      "-f", "s16le",
      "-ar", String(req.fromSampleRate ?? 16000),
      "-ac", "1",
    );
  }
  args.push("-i", "pipe:0");

  // 输出：统一重采样 + 单声道
  args.push("-ar", String(toRate), "-ac", String(toCh));

  switch (to) {
    case "pcm16":
      args.push("-f", "s16le");
      break;
    case "opus":
      args.push("-c:a", "libopus", "-b:a", "24k", "-f", "ogg");
      break;
    case "mp3":
      args.push("-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3");
      break;
    case "wav":
      args.push("-c:a", "pcm_s16le", "-f", "wav");
      break;
  }

  args.push("pipe:1");
  return args;
}

/**
 * 从 OGG/Opus 字节流解析时长毫秒。
 *
 * 与飞书 SDK 内部 parseOpusDuration 同算法：反向扫描最后一个 `OggS`
 * 页捕获模式，读其 granule_position（+6 处 64-bit LE）。Opus 的
 * granule 是 48kHz 解码样本数，除以 48 即毫秒。
 *
 * 自己实现而不依赖 SDK：转码层不该 import 飞书 SDK（本能力也被非飞书
 * 场景消费），且需要把时长作为转码结果的一部分回传。
 */
export function parseOggOpusDurationMs(buf: Buffer): number | undefined {
  if (!buf || buf.length < 27) return undefined;
  for (let i = buf.length - 27; i >= 0; i--) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) {
      const granule = buf.readBigInt64LE(i + 6);
      if (granule < BigInt(0)) return undefined;
      const ms = Number(granule) / 48;
      if (!Number.isFinite(ms) || ms < 0) return undefined;
      return Math.round(ms);
    }
  }
  return undefined;
}

/** 裸 PCM 字节数 → 毫秒（16-bit 单声道：每样本 2 字节） */
export function pcmDurationMs(byteLength: number, sampleRate: number, channels = 1): number {
  const bytesPerFrame = 2 * channels;
  if (sampleRate <= 0 || byteLength <= 0) return 0;
  return Math.round((byteLength / bytesPerFrame / sampleRate) * 1000);
}

// ── ffmpeg 执行 ──────────────────────────────────────────────────

/** 用管道把 buffer 喂给 ffmpeg，收集 stdout；stderr 仅用于失败诊断 */
function runFfmpeg(
  args: string[],
  input: Buffer,
  timeoutMs: number,
): Promise<{ ok: true; out: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: `无法启动 ffmpeg: ${(e as Error).message}` });
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: `ffmpeg 转码超时（${timeoutMs}ms）` });
    }, timeoutMs);

    const finish = (r: { ok: true; out: Buffer } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (e) =>
      finish({ ok: false, error: `ffmpeg 执行失败: ${e.message}（是否未安装？FFMPEG_PATH 可指定路径）` }),
    );
    child.on("close", (code) => {
      if (code === 0) {
        const out = Buffer.concat(outChunks);
        if (out.length === 0) {
          finish({ ok: false, error: "ffmpeg 输出为空（源音频可能无有效音轨）" });
          return;
        }
        finish({ ok: true, out });
      } else {
        const detail = Buffer.concat(errChunks).toString("utf8").trim().split("\n").slice(-3).join(" | ");
        finish({ ok: false, error: `ffmpeg 退出码 ${code}: ${detail || "(无 stderr 输出)"}` });
      }
    });

    // EPIPE：ffmpeg 提前退出（如输入无法解析）时会砸到 stdin，忽略即可——
    // 真正的失败原因由 close 回调里的退出码与 stderr 给出。
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

// ── Provider 实现 ────────────────────────────────────────────────

export const audioTranscodeProvider: Provider<
  AudioTranscodeRequest,
  AudioTranscodeResponse
> = {
  service: audioTranscodeService,
  name: "action-audio-transcode-ffmpeg",
  state: PluginState.Active,

  async execute(
    request: AudioTranscodeRequest,
    ctx: SeamContext,
  ): Promise<Result<AudioTranscodeResponse>> {
    if (!Buffer.isBuffer(request.audio) || request.audio.length === 0) {
      return err("audio-transcode: request.audio 必须是非空 Buffer");
    }
    if (request.from === request.to && !request.toSampleRate) {
      // 同格式同采样率 = 无操作，仍有价值（例如仅需降声道），继续走 ffmpeg 统一形态
    }

    const to = request.to;
    const toRate = request.toSampleRate ?? defaultSampleRate(to);
    const toCh = request.toChannels ?? 1;
    const timeoutMs = request.timeoutMs ?? 60_000;

    ctx.emit({
      type: "audio.transcode",
      layer: LayerId.Action,
      payload: { from: request.from ?? "auto", to, toRate, toCh, inBytes: request.audio.length },
      traceId: ctx.traceId,
    });

    const args = buildFfmpegArgs(request);
    const r = await runFfmpeg(args, request.audio, timeoutMs);
    if (!r.ok) return err(`audio-transcode: ${r.error}`);

    const durationMs =
      to === "opus"
        ? parseOggOpusDurationMs(r.out)
        : to === "pcm16"
          ? pcmDurationMs(r.out.length, toRate, toCh)
          : undefined;

    return ok({
      audio: r.out,
      format: to,
      sampleRate: toRate,
      channels: toCh,
      durationMs,
    });
  },

  async health(): Promise<HealthStatus> {
    // 真在线探测：PATH 上找得到且可执行才算 healthy。
    // 不使用 `ffmpeg -version`（启动开销 ~50ms 且健康探针会被高频调用）。
    const candidates = [ffmpegBin()];
    for (const c of candidates) {
      try {
        await access(c, constants.X_OK);
        return {
          healthy: true,
          detail: `ffmpeg ready (${c})`,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        // 非绝对路径时 access 相对 cwd 解析，失败不代表不在 PATH 上；
        // 用 spawn 做一次真实探测兜底。
      }
    }
    const probed = await runFfmpeg(["-version"], Buffer.alloc(0), 5_000);
    return {
      healthy: probed.ok,
      detail: probed.ok
        ? `ffmpeg ready (${ffmpegBin()})`
        : `ffmpeg 不可用：${probed.error}（安装：apt install ffmpeg，或设 FFMPEG_PATH）`,
      checkedAt: new Date().toISOString(),
    };
  },
};