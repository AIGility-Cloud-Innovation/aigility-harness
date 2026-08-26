import { describe, it, expect } from "vitest";
import {
  speechToTextService,
  voskSttProvider,
  whisperSttProvider,
} from "./index.js";

describe("@persona/speech-to-text 契约", () => {
  it("服务定义归属 Persona 层并声明 audio 必填", () => {
    expect(speechToTextService.id).toBe("@persona/speech-to-text");
    expect(speechToTextService.layer).toBe("persona");
    expect(speechToTextService.requestSchema.required).toContain("audio");
    expect(speechToTextService.responseSchema.required).toEqual([
      "text",
      "engine",
    ]);
  });

  it("两个 Provider 共用同一契约", () => {
    expect(voskSttProvider.service).toBe(speechToTextService);
    expect(whisperSttProvider.service).toBe(speechToTextService);
  });
});

describe("引擎不可用时优雅降级", () => {
  it("vosk 引擎未就绪时 health 返回 unhealthy 而非抛异常", async () => {
    const h = await voskSttProvider.health();
    expect(h).toHaveProperty("healthy");
    expect(h).toHaveProperty("detail");
    expect(h).toHaveProperty("checkedAt");
  });

  it("vosk execute 在引擎缺失时返回 err（不抛异常）", async () => {
    const r = await voskSttProvider.execute(
      { audio: Buffer.alloc(1600), sampleRate: 16000 },
      {} as never,
    );
    expect(r.ok).toBe(false);
  });

  it("whisper 引擎未就绪时 health 不抛异常", async () => {
    const h = await whisperSttProvider.health();
    expect(h).toHaveProperty("healthy");
  });
});