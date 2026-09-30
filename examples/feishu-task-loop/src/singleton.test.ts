import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  acquireBotLock,
  botHolderAlive,
} from "@aigility-harness/layer-infrastructure";

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

/** 本包机器人锁的获取入口（实现已泛化到 layer-infrastructure/bot-singleton，此处按真实参数组合回归） */
function acquireSingletonLock(lockPath = "/tmp/aigility-feishu-task-loop.lock") {
  return acquireBotLock("feishu-task-loop", { lockPath, cwdMarker: "feishu-task-loop" });
}

describe("singleton lock（共享实现 · feishu-task-loop 参数组合）", () => {
  it("acquire 成功：锁文件写入本进程 PID", () => {
    const path = tmpLock();
    const lock = acquireSingletonLock(path);
    expect(lock).not.toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock!.release();
    cleanup(path);
  });

  it("互斥：持有者存活时第二次获取返回 null", () => {
    const path = tmpLock();
    const first = acquireSingletonLock(path);
    expect(first).not.toBeNull();
    // vitest 进程自身存活且 cwd 在本包目录 → 持有者探活通过
    expect(acquireSingletonLock(path)).toBeNull();
    first!.release();
    cleanup(path);
  });

  it("release 后锁文件删除，可重新获取", () => {
    const path = tmpLock();
    const first = acquireSingletonLock(path);
    first!.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireSingletonLock(path);
    expect(second).not.toBeNull();
    second!.release();
    cleanup(path);
  });

  it("僵锁自愈：持有者已死 → 自动接管", () => {
    const path = tmpLock();
    const pid = deadPid();
    expect(botHolderAlive(pid, "feishu-task-loop")).toBe(false);
    writeFileSync(path, String(pid));
    const lock = acquireSingletonLock(path);
    expect(lock).not.toBeNull();
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock!.release();
    cleanup(path);
  });

  it("内容损坏 → 视为僵锁自动接管", () => {
    const path = tmpLock();
    writeFileSync(path, "not-a-pid");
    const lock = acquireSingletonLock(path);
    expect(lock).not.toBeNull();
    lock!.release();
    cleanup(path);
  });

  it("release 幂等：重复调用不抛错", () => {
    const path = tmpLock();
    const lock = acquireSingletonLock(path);
    lock!.release();
    expect(() => lock!.release()).not.toThrow();
    cleanup(path);
  });
});
