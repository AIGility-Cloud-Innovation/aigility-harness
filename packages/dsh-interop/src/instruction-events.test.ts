/**
 * M-D 轮 2 单测：指令注入事件解析。
 * 夹具取自 2026-10-08 实测会话（DSH 0.2.0-rc.2）真实事件行，非编造。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import {
  cwdToSessionDirName,
  findLatestSessionFile,
  parseInstructionEvents,
  summarizeInstructions,
  summarizeLatestInstructions,
} from "./instruction-events.js";

// 真实事件行（实测样本，仅截断 digest 与正文长度以便阅读）
const REAL_INJECTION_LINE = JSON.stringify({
  type: "user/message",
  seq: 9,
  time: 1791471603534,
  data: {
    content: [
      {
        type: "text",
        text:
          "<system-reminder>\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.\n\nInstructions from: AGENTS-sales-chat.md\n\n你是「销售客服」，智悦平台的客户服务角色。职责边界如下：\n\n1. **解答系统使用问题**。\n</system-reminder>",
      },
    ],
    source: {
      kind: "agent-instructions",
      form: "instructions",
      baseline: true,
      baselineIdentity:
        '{"projectRoot":"","projectRootMarkers":[".git"],"maxBytes":65536,"instructionFileCandidates":["AGENTS-sales-chat.md"]}',
      changes: [
        {
          action: "set",
          scope: ".\u0000AGENTS-sales-chat.md",
          path: "AGENTS-sales-chat.md",
          digest: "a5b332b11ea8787218578e0eb27d83bd39fb6a39",
        },
      ],
    },
    role: "user",
    id: "c880e914-06a8-445b-b06b-4cf4b19b3814",
  },
  surfaceOp: "append",
});

const SESSION_HEADER_LINE = JSON.stringify({ type: "session", seq: 1, time: 1791471600000, data: {} });
const ORDINARY_LINE = JSON.stringify({
  type: "assistant/message",
  seq: 10,
  time: 1791471603600,
  data: { content: [{ type: "text", text: "ok" }] },
});

describe("cwdToSessionDirName", () => {
  it("把绝对路径转成 DSH sessions 子目录名（实测规则）", () => {
    expect(cwdToSessionDirName("/home/johnny/ws")).toBe("--home-johnny-ws--");
    expect(cwdToSessionDirName("/home/johnny/.hermes/cache/scratch/md-probe-ws-1791471602570")).toBe(
      "--home-johnny-.hermes-cache-scratch-md-probe-ws-1791471602570--",
    );
  });

  it("容忍尾部分隔符", () => {
    expect(cwdToSessionDirName("/home/johnny/ws/")).toBe("--home-johnny-ws--");
  });
});

describe("parseInstructionEvents", () => {
  it("只挑出 agent-instructions 事件，忽略其它类型", () => {
    const ndjson = [SESSION_HEADER_LINE, REAL_INJECTION_LINE, ORDINARY_LINE].join("\n");
    const events = parseInstructionEvents(ndjson);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(9);
    expect(events[0].form).toBe("instructions");
    expect(events[0].baseline).toBe(true);
  });

  it("剥掉 system-reminder 包裹与说明段，只留角色正文", () => {
    const [ev] = parseInstructionEvents(REAL_INJECTION_LINE);
    expect(ev.text).toContain("你是「销售客服」");
    expect(ev.text).not.toContain("system-reminder");
    expect(ev.text).not.toContain("The following workspace instructions");
    expect(ev.text).not.toContain("Instructions from:");
    expect(ev.bytes).toBeGreaterThan(0);
  });

  it("提取 changes 与候选文件名", () => {
    const [ev] = parseInstructionEvents(REAL_INJECTION_LINE);
    expect(ev.changes).toEqual([
      { action: "set", path: "AGENTS-sales-chat.md", digest: "a5b332b11ea8787218578e0eb27d83bd39fb6a39" },
    ]);
  });

  it("坏行跳过，不整体失败", () => {
    const ndjson = ["{不是合法json", REAL_INJECTION_LINE, "  ", '{"type":"torn"'].join("\n");
    const events = parseInstructionEvents(ndjson);
    expect(events).toHaveLength(1);
  });

  it("按 seq 升序返回", () => {
    const later = JSON.stringify({
      type: "user/message",
      seq: 20,
      time: 1791471605000,
      data: {
        content: [{ type: "text", text: "<system-reminder>\n第二轮\n</system-reminder>" }],
        source: { kind: "agent-instructions", form: "instructions", baseline: false, changes: [] },
      },
    });
    const events = parseInstructionEvents([later, REAL_INJECTION_LINE].join("\n"));
    expect(events.map((e) => e.seq)).toEqual([9, 20]);
  });

  it("无注入事件的会话返回空数组", () => {
    expect(parseInstructionEvents([SESSION_HEADER_LINE, ORDINARY_LINE].join("\n"))).toEqual([]);
  });
});

describe("summarizeInstructions", () => {
  it("文件不存在 → 空概览，不抛错", () => {
    const s = summarizeInstructions("/nonexistent/session.v4.jsonl.zstd");
    expect(s).toEqual({ file: "", totalEvents: 0, injections: [], candidateFiles: [] });
  });

  it("文件为 null → 空概览", () => {
    expect(summarizeInstructions(null).injections).toEqual([]);
  });

  it("解压 .zstd 并汇总（端到端含压缩）", () => {
    const dir = join(tmpdir(), `mdc-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.v4.jsonl.zstd");
    const ndjson = [SESSION_HEADER_LINE, REAL_INJECTION_LINE, ORDINARY_LINE].join("\n");
    writeFileSync(file, zstdCompressSync(Buffer.from(ndjson, "utf8")));
    const s = summarizeInstructions(file);
    expect(s.totalEvents).toBe(3);
    expect(s.injections).toHaveLength(1);
    expect(s.candidateFiles).toEqual(["AGENTS-sales-chat.md"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("多帧 zstd（DSH 追加写）必须解出全部帧内容——防回归", () => {
    // DSH 每批事件追加一帧；zstdDecompressSync 只解第一帧会静默丢内容（实测 8 帧只出 215/33265 字节）
    const dir = join(tmpdir(), `mdm-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.v4.jsonl.zstd");
    const frame1 = zstdCompressSync(Buffer.from(SESSION_HEADER_LINE + "\n"));
    const frame2 = zstdCompressSync(Buffer.from(REAL_INJECTION_LINE + "\n"));
    const frame3 = zstdCompressSync(Buffer.from(ORDINARY_LINE + "\n"));
    writeFileSync(file, Buffer.concat([frame1, frame2, frame3]));
    const s = summarizeInstructions(file);
    expect(s.totalEvents).toBe(3); // 丢帧会变成 1
    expect(s.injections).toHaveLength(1); // 丢帧会变成 0
    expect(s.injections[0].text).toContain("你是「销售客服」");
    rmSync(dir, { recursive: true, force: true });
  });

  it("同一会话多文件变更时 candidateFiles 去重", () => {
    const mk = (seq: number, path: string) =>
      JSON.stringify({
        type: "user/message",
        seq,
        time: 1000 + seq,
        data: {
          content: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }],
          source: {
            kind: "agent-instructions",
            form: "instructions",
            baseline: seq === 1,
            changes: [{ action: "set", path, digest: "d" }],
          },
        },
      });
    const events = parseInstructionEvents([mk(1, "AGENTS-sales-chat.md"), mk(2, "AGENTS-sales-chat.md"), mk(3, "AGENTS-other.md")].join("\n"));
    expect([...new Set(events.flatMap((e) => e.changes.map((c) => c.path)))]).toEqual([
      "AGENTS-sales-chat.md",
      "AGENTS-other.md",
    ]);
  });
});

describe("findLatestSessionFile / summarizeLatestInstructions", () => {
  it("按 cwd 定位会话文件并取最新", () => {
    const dshHome = join(tmpdir(), `mdh-${Date.now()}`);
    const cwd = join(tmpdir(), `mdw-${Date.now()}`);
    const sessRoot = join(dshHome, "sessions", cwdToSessionDirName(cwd));
    const older = join(sessRoot, "session-aaaa");
    const newer = join(sessRoot, "session-bbbb");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(SESSION_HEADER_LINE)));
    writeFileSync(
      join(newer, "session.v4.jsonl.zstd"),
      zstdCompressSync(Buffer.from([SESSION_HEADER_LINE, REAL_INJECTION_LINE].join("\n"))),
    );

    const file = findLatestSessionFile(dshHome, cwd);
    expect(file).toBe(join(newer, "session.v4.jsonl.zstd"));

    const s = summarizeLatestInstructions(dshHome, cwd);
    expect(s.injections).toHaveLength(1);
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("无会话目录 → null / 空概览", () => {
    expect(findLatestSessionFile("/nonexistent-home", "/nonexistent-cwd")).toBeNull();
    expect(summarizeLatestInstructions("/nonexistent-home", "/nonexistent-cwd").injections).toEqual([]);
  });
});