import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  acquireBotLock,
  botHolderAlive,
  botLockPath,
} from "./bot-singleton.js";

function tmpLock(): string {
  return `/tmp/aigility-test-lock-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function cleanup(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 不存在 */
  }
}

/** 产出一个确定已退出的 PID（用于僵锁场景，避免碰真实进程） */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid as number;
}

describe("bot singleton lock", () => {
  it("acquire 成功：锁文件写入本进程 PID", () => {
    const path = tmpLock();
    const lock = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "layer-infrastructure" });
    expect(lock).not.toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock!.release();
    cleanup(path);
  });

  it("默认锁路径 = /tmp/aigility-<botName>.lock", () => {
    expect(botLockPath("feishu-dsh")).toBe("/tmp/aigility-feishu-dsh.lock");
  });

  it("互斥：持有者存活时第二次获取返回 null", () => {
    const path = tmpLock();
    // vitest 进程自身存活且 cwd 在本包目录 → cwdMarker 取包名使探活通过
    const first = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "layer-infrastructure" });
    expect(first).not.toBeNull();
    expect(acquireBotLock("test-bot", { lockPath: path, cwdMarker: "layer-infrastructure" })).toBeNull();
    first!.release();
    cleanup(path);
  });

  it("持有者存活但 cwd 不含标记（PID 被复用）→ 判为僵锁接管", () => {
    const path = tmpLock();
    // 用一个不可能匹配的 cwd 标记：本进程 cwd 不含它 → 视为僵锁
    writeFileSync(path, String(process.pid));
    const lock = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "/no-such-cwd-marker" });
    expect(lock).not.toBeNull();
    lock!.release();
    cleanup(path);
  });

  it("release 后锁文件删除，可重新获取", () => {
    const path = tmpLock();
    const first = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "layer-infrastructure" });
    first!.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "layer-infrastructure" });
    expect(second).not.toBeNull();
    second!.release();
    cleanup(path);
  });

  it("僵锁自愈：持有者已死 → 自动接管", () => {
    const path = tmpLock();
    const pid = deadPid();
    expect(botHolderAlive(pid, "test-bot")).toBe(false);
    writeFileSync(path, String(pid));
    const lock = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "test-bot" });
    expect(lock).not.toBeNull();
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock!.release();
    cleanup(path);
  });

  it("内容损坏 → 视为僵锁自动接管", () => {
    const path = tmpLock();
    writeFileSync(path, "not-a-pid");
    const lock = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "test-bot" });
    expect(lock).not.toBeNull();
    lock!.release();
    cleanup(path);
  });

  it("release 幂等：重复调用不抛错", () => {
    const path = tmpLock();
    const lock = acquireBotLock("test-bot", { lockPath: path, cwdMarker: "test-bot" });
    lock!.release();
    expect(() => lock!.release()).not.toThrow();
    cleanup(path);
  });
});
