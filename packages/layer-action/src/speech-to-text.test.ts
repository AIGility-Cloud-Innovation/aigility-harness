import { describe, it, expect } from "vitest";
import {
  speechToTextService,
  voskSttProvider,
  whisperSttProvider,
  normalizeVoskText,
  normalizeRemoteHost,
  WHISPER_REMOTE_HOST,
  whisperModelCacheDir,
} from "./index.js";

describe("@action/speech-to-text 契约", () => {
  it("服务定义归属 Action 层并声明 audio 必填", () => {
    expect(speechToTextService.id).toBe("@action/speech-to-text");
    expect(speechToTextService.layer).toBe("action");
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

// ── vosk 中文分词空格合并（实测缺陷回归）─────────────────────────
// 真机实测：vosk 中文模型输出 "今天 天气 不错 我们 开 个 会 吧"，
// 若原样当 user_input 喂人格层，^ 锚定的意图正则与关键词匹配全被打散。
describe("normalizeVoskText — 中文词间空格合并", () => {
  it("删除 CJK 之间的空格（真机实测样本）", () => {
    expect(normalizeVoskText("今天 天气 不错 我们 开 个 会 吧")).toBe(
      "今天天气不错我们开个会吧",
    );
  });

  it("连续多空格一并折叠", () => {
    expect(normalizeVoskText("建  个  任务")).toBe("建个任务");
  });

  it("首尾空白清除", () => {
    expect(normalizeVoskText("   我的任务   ")).toBe("我的任务");
  });

  it("中英混排保留英文侧空格（删掉会把两个词粘成不存在的词）", () => {
    expect(normalizeVoskText("打开 api 文档")).toBe("打开 api 文档");
  });

  it("纯英文原样保留", () => {
    expect(normalizeVoskText("create a task")).toBe("create a task");
  });

  it("中文标点与汉字之间不误删标点", () => {
    const out = normalizeVoskText("第一句 话 讲完 了。第二句 话");
    expect(out).toBe("第一句话讲完了。第二句话");
    expect(out).toContain("。");
  });

  it("空串/纯空白返回空串", () => {
    expect(normalizeVoskText("")).toBe("");
    expect(normalizeVoskText("   ")).toBe("");
  });

  it("意图正则合并后可命中（端到端语义验证）", () => {
    const out = normalizeVoskText("建 任务 修复 导出");
    expect(/^建任务/.test(out)).toBe(true);
  });
});

// ── whisper 镜像自适配（HF_ENDPOINT 陷阱回归）────────────────────
describe("whisper remoteHost 归一化", () => {
  it("补尾斜杠（transformers.js 拼接 remotePathTemplate 依赖它）", () => {
    expect(normalizeRemoteHost("https://hf-mirror.com")).toBe("https://hf-mirror.com/");
  });

  it("已有尾斜杠不重复添加", () => {
    expect(normalizeRemoteHost("https://hf-mirror.com/")).toBe("https://hf-mirror.com/");
  });

  it("空串回落到镜像默认值（避免 remoteHost='' 导致相对路径请求）", () => {
    expect(normalizeRemoteHost("   ")).toBe("https://hf-mirror.com/");
  });

  it("默认走 hf-mirror（huggingface.co 在本机不可达）", () => {
    expect(WHISPER_REMOTE_HOST).toBeTruthy();
    expect(normalizeRemoteHost(WHISPER_REMOTE_HOST)).toMatch(/\/$/);
  });

  it("模型缓存目录按 org--model 形态推导", () => {
    expect(whisperModelCacheDir("Xenova/whisper-tiny", "/tmp/hf")).toBe(
      "/tmp/hf/hub/Xenova--whisper-tiny",
    );
  });
});