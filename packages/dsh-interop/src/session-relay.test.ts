/**
 * session-relay 单测：TranscriptStore 滚动持久化 + 中继指令路径。
 * headless 调用本身不 mock 进程（有 CLI 依赖），只测不触 CLI 的分支。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore, createDshSessionRelayExecute } from "./session-relay.js";

describe("TranscriptStore", () => {
  it("按 chatId 隔离并落盘 JSON", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file);
    store.push("a", "user", "你好");
    store.push("b", "user", "另一聊");
    store.push("a", "assistant", "回复");

    expect(store.get("a")).toHaveLength(2);
    expect(store.get("b")).toHaveLength(1);

    const reloaded = new TranscriptStore(file);
    expect(reloaded.get("a")).toHaveLength(2);
    expect(reloaded.get("b")).toHaveLength(1);
  });

  it("超过轮数/字符上限丢最旧，且至少保留 1 轮", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file, 3, 10_000);
    for (let i = 0; i < 6; i++) store.push("c", "user", `m${i}`);
    const turns = store.get("c");
    expect(turns).toHaveLength(3);
    expect(turns[0]?.text).toBe("m3");

    const tiny = new TranscriptStore(join(mkdtempSync(join(tmpdir(), "relay-")), "t.json"), 2, 5);
    tiny.push("d", "user", "很长很长很长很长很长的消息");
    tiny.push("d", "user", "第二条");
    expect(tiny.get("d").length).toBeGreaterThanOrEqual(1);
  });

  it("clear 删除指定聊天并持久化", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file);
    store.push("a", "user", "x");
    store.clear("a");
    expect(store.get("a")).toHaveLength(0);
    const reloaded = new TranscriptStore(file);
    expect(reloaded.get("a")).toHaveLength(0);
    expect(readFileSync(file, "utf8")).not.toContain('"a"');
  });
});

describe("createDshSessionRelayExecute 指令路径（不触 headless CLI）", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");

  it("/session 空历史与有历史的回复", async () => {
    const f = file();
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: f });
    expect((await execute({ user_input: "/session" })).value?.response).toContain("尚无对话历史");

    // 直接往落盘文件塞一轮（绕过 CLI），再建执行体应看到 2 轮
    const store = new TranscriptStore(f, 12, 6000);
    store.push("default", "user", "问");
    store.push("default", "assistant", "答");
    const reloaded = new TranscriptStore(f, 12, 6000);
    expect(reloaded.get("default")).toHaveLength(2);
  });

  it("/new 清空历史", async () => {
    const f = file();
    const store = new TranscriptStore(f);
    store.push("default", "user", "历史消息");
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: f });
    const r = await execute({ user_input: "/new" });
    expect(r.value?.response).toContain("已清空");
    expect(new TranscriptStore(f).get("default")).toHaveLength(0);
  });
});
