/**
 * 单实例守护：锁文件（wx 原子独占）+ 持有者 PID 探活 + 僵锁自愈。
 *
 * 为什么不用端口占用 / 系统 flock：tsx 启动链是 bash → tsx cli → node worker
 * 三层进程，真正持有飞书 WS 的是 worker（孤儿化后仍存活）；锁文件写在应用层、
 * 内容记 worker PID，探活用「信号 0 + /proc cwd 校验」双判——
 *   - kill -9 整树残留 → worker 死 → 信号探活失败 → 下次启动自动接管
 *   - worker 孤儿但存活 → 锁仍被持有 → 新实例拒绝启动（防双实例抢事件）
 *   - PID 被无关进程复用 → cwd 不在 feishu-task-loop → 判为僵锁接管
 */
import {
  closeSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface SingletonLock {
  /** 释放锁（正常退出路径调用；kill -9 残留的锁由下次启动自愈） */
  release(): void;
}

export function defaultLockPath(): string {
  return process.env["TASK_LOOP_LOCK_PATH"] ?? "/tmp/aigility-feishu-task-loop.lock";
}

/**
 * 持有者是否真的活着：信号 0 探活 + cwd 落在目标目录（防 PID 复用误判）。
 * /proc 不可读（非 Linux）时退化为仅信号探活。
 */
export function holderAlive(pid: number, cwdMarker = "feishu-task-loop"): boolean {
  try {
    process.kill(pid, 0); // 信号 0 = 只探活不投递
  } catch {
    return false;
  }
  try {
    return readlinkSync(`/proc/${pid}/cwd`).includes(cwdMarker);
  } catch {
    return true;
  }
}

/**
 * 获取单实例锁。
 * - 无锁 → 原子创建并写入本进程 PID，返回锁句柄
 * - 有锁且持有者存活 → 返回 null（调用方应报错退出）
 * - 有锁但持有者已死 / 内容损坏 → 清理僵锁后接管；接管被并发抢占 → 返回 null
 */
export function acquireSingletonLock(lockPath = defaultLockPath()): SingletonLock | null {
  const tryCreate = (): number | null => {
    try {
      const fd = openSync(lockPath, "wx"); // 独占创建：已存在即抛错
      writeSync(fd, String(process.pid));
      return fd;
    } catch {
      return null;
    }
  };

  let fd = tryCreate();
  if (fd === null) {
    let stale = true;
    try {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && holderAlive(pid)) {
        stale = false;
      }
    } catch {
      // 内容不可读 → 视为僵锁
    }
    if (!stale) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      return null; // 清理失败 = 被并发接管
    }
    fd = tryCreate();
  }
  if (fd === null) return null;

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* 已被清理 */
      }
    },
  };
}
