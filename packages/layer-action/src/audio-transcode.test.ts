import { describe, it, expect } from "vitest";
import {
  audioTranscodeService,
  audioTranscodeProvider,
  buildFfmpegArgs,
  defaultSampleRate,
  parseOggOpusDurationMs,
  pcmDurationMs,
  ffmpegBin,
} from "./index.js";

describe("@action/audio-transcode 契约", () => {
  it("归属 Action 层并声明 audio/to 必填", () => {
    expect(audioTranscodeService.id).toBe("@action/audio-transcode");
    expect(audioTranscodeService.layer).toBe("action");
    expect(audioTranscodeService.requestSchema.required).toEqual(["audio", "to"]);
  });

  it("Provider 绑定同一契约", () => {
    expect(audioTranscodeProvider.service).toBe(audioTranscodeService);
  });
});

describe("defaultSampleRate — STT 必须 16k", () => {
  it("pcm16 默认 16000（vosk/whisper 训练采样率）", () => {
    expect(defaultSampleRate("pcm16")).toBe(16000);
  });

  it("opus 默认 48000（编解码器规范）", () => {
    expect(defaultSampleRate("opus")).toBe(48000);
  });
});

describe("buildFfmpegArgs — 裸 PCM 必须显式声明输入格式", () => {
  it("from=pcm16 时带 -f s16le 与输入采样率", () => {
    const args = buildFfmpegArgs({ audio: Buffer.alloc(0), from: "pcm16", to: "opus" });
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe("s16le");
    expect(args).toContain("-ar");
    // 输入侧声明
    expect(args.slice(0, args.indexOf("-i"))).toContain("16000");
  });

  it("容器格式（mp3→opus）不声明输入格式，让 ffmpeg 自行探测", () => {
    const args = buildFfmpegArgs({ audio: Buffer.alloc(0), from: "mp3", to: "opus" });
    const beforeInput = args.slice(0, args.indexOf("-i"));
    expect(beforeInput).not.toContain("s16le");
  });

  it("opus 输出走 libopus + ogg 容器（飞书语音要求）", () => {
    const args = buildFfmpegArgs({ audio: Buffer.alloc(0), to: "opus" });
    expect(args).toContain("libopus");
    expect(args[args.indexOf("-f", args.indexOf("-i")) + 1]).toBe("ogg");
  });

  it("pcm16 输出用 s16le，且始终重采样到单声道", () => {
    const args = buildFfmpegArgs({ audio: Buffer.alloc(0), to: "pcm16", toSampleRate: 16000 });
    expect(args).toContain("-ac");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    // 输出侧采样率在 -i 之后
    const afterInput = args.slice(args.indexOf("-i"));
    expect(afterInput).toContain("-ar");
    expect(afterInput[afterInput.indexOf("-ar") + 1]).toBe("16000");
  });

  it("管道进管道出（不落中间文件）", () => {
    const args = buildFfmpegArgs({ audio: Buffer.alloc(0), to: "pcm16" });
    expect(args).toContain("pipe:0");
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  it("对空 Buffer 也返回错误而非抛异常（execute 边界）", async () => {
    const r = await audioTranscodeProvider.execute(
      { audio: Buffer.alloc(0), to: "pcm16" },
      { emit: () => {} } as never,
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseOggOpusDurationMs", () => {
  it("无 OggS 页返回 undefined", () => {
    expect(parseOggOpusDurationMs(Buffer.alloc(100))).toBeUndefined();
  });

  it("过短缓冲返回 undefined", () => {
    expect(parseOggOpusDurationMs(Buffer.alloc(10))).toBeUndefined();
  });

  it("从 granule_position 换算毫秒（48 样本/ms）", () => {
    // 构造：27 字节缓冲，offset 0 处放 OggS，+6 处放 granule=48000 → 1000ms
    const buf = Buffer.alloc(30);
    buf.write("OggS", 0, "ascii");
    buf.writeBigInt64LE(BigInt(48000), 6);
    expect(parseOggOpusDurationMs(buf)).toBe(1000);
  });
});

describe("pcmDurationMs", () => {
  it("16k 单声道 2 字节/样本：32000 字节 = 1000ms", () => {
    expect(pcmDurationMs(32000, 16000, 1)).toBe(1000);
  });

  it("空/非法输入返回 0", () => {
    expect(pcmDurationMs(0, 16000)).toBe(0);
    expect(pcmDurationMs(100, 0)).toBe(0);
  });
});

describe("ffmpeg 缺失时优雅降级", () => {
  it("ffmpegBin() 可由 FFMPEG_PATH 覆盖（默认 ffmpeg）", () => {
    expect(typeof ffmpegBin()).toBe("string");
    expect(ffmpegBin().length).toBeGreaterThan(0);
  });

  it("health 返回三字段结构且不抛异常", async () => {
    const h = await audioTranscodeProvider.health();
    expect(h).toHaveProperty("healthy");
    expect(h).toHaveProperty("detail");
    expect(h).toHaveProperty("checkedAt");
  });
});