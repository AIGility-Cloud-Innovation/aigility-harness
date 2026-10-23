/**
 * 机器人单实例守护（共享实现，泛化自 feishu-task-loop singleton）：
 * 锁文件（wx 原子独占）+ 持有者 PID 探活 + 僵锁自愈。
 *
 * 为什么不用端口占用 / 系统 flock：tsx 启动链是 bash → tsx cli → node worker
 * 三层进程，真正持有长连接（飞书 WS / 企微回调）的是 worker（孤儿化后仍存活）；
 * 锁文件写在应用层、内容记 worker PID，探活用「信号 0 + /proc cwd 校验」双判——
 *   - kill -9 整树残留 → worker 死 → 信号探活失败 → 下次启动自动接管
 *   - worker 孤儿但存活 → 锁仍被持有 → 新实例拒绝启动（防双实例抢事件）
 *   - PID 被无关进程复用 → cwd 不含机器人标记 → 判为僵锁接管
 *
 * 所有长连外部通道的事件驱动机器人（feishu-* / wecom-*）都应在 main() 最前
 * acquireBotLock；锁在正常退出时最好 release，kill -9 残留由下次启动自愈。
 */
import {
  closeSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface BotSingletonLock {
  /** 释放锁（正常退出路径调用；kill -9 残留的锁由下次启动自愈） */
  release(): void;
}

export interface BotLockOptions {
  /** 锁文件路径（缺省 /tmp/aigility-<botName>.lock） */
  lockPath?: string;
  /** cwd 标记（防 PID 复用误判），缺省 botName */
  cwdMarker?: string;
}

/** 默认锁路径：/tmp/aigility-<botName>.lock */
export function botLockPath(botName: string): string {
  return `/tmp/aigility-${botName}.lock`;
}

/**
 * 持有者是否真的活着：信号 0 探活 + cwd 含机器人标记（防 PID 复用误判）。
 * /proc 不可读（非 Linux）时退化为仅信号探活。
 */
export function botHolderAlive(pid: number, cwdMarker: string): boolean {
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
 * 获取机器人单实例锁。
 * - 无锁 → 原子创建并写入本进程 PID，返回锁句柄
 * - 有锁且持有者存活 → 返回 null（调用方应报错退出）
 * - 有锁但持有者已死 / 内容损坏 → 清理僵锁后接管；接管被并发抢占 → 返回 null
 */
export function acquireBotLock(botName: string, opts: BotLockOptions = {}): BotSingletonLock | null {
  const lockPath = opts.lockPath ?? botLockPath(botName);
  const cwdMarker = opts.cwdMarker ?? botName;

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
      if (Number.isInteger(pid) && pid > 0 && botHolderAlive(pid, cwdMarker)) {
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
  // 运行时守卫（2026-10-23 双实例事故复盘）：锁文件被外力删除后，另一实例可重构
  // 锁并启动 → 双写者交替破坏数据（现网曾致任务标题连环叠标 ×7）。每 30s 校验
  // 锁文件仍在且写的是本 pid，不符即自杀退出，交由启动方/看护重新拉起单实例。
  const watch = setInterval(() => {
    try {
      const cur = readFileSync(lockPath, "utf8").trim();
      if (cur !== String(process.pid)) {
        console.error(`[bot-singleton] 锁被接管（文件内容=${cur || "空"}，本 pid=${process.pid}）→ 自杀退出防双实例双写`);
        process.exit(1);
      }
    } catch {
      console.error(`[bot-singleton] 锁文件丢失（被删除/未落盘）→ 自杀退出防双实例双写`);
      process.exit(1);
    }
  }, 30_000);
  watch.unref?.();
  return {
    release(): void {
      if (released) return;
      released = true;
      clearInterval(watch);
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
