/**
 * 托管应用自动拉起 —— 智悦平台被进程守护（systemd）启动时，代拉配置里的伴生应用。
 *
 * 设计：
 *   - 配置 = config/managed-apps.json（应用名/命令/cwd/锁文件，页面可改前先文件配）；
 *   - 幂等：应用自带锁文件（如 task-loop 的 /tmp/*.lock 内含 pid），pid 活着就跳过，
 *     所以平台重启不会重复拉起，platform 崩溃也不影响已拉起的应用（detached 独立进程）；
 *   - 日志：各应用 stdout/stderr 追加到自己的 log 文件（与手工 nohup 同一文件，无割裂）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ManagedAppConfig {
  apps?: Array<{
    name: string;
    /** 相对仓库根的启动目录 */
    cwd: string;
    command: string;
    args?: string[];
    /** stdout/stderr 追加目标（相对仓库根；缺省 data/managed-<name>.log） */
    log?: string;
    /** 幂等锁文件（内含 pid，JSON 或纯文本均可）；pid 活着 → 跳过拉起 */
    lockFile?: string;
    enabled?: boolean;
  }>;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** src/ → aigility-platform → examples → 仓库根 */
const REPO_ROOT = resolve(MODULE_DIR, "../../..");
const CONFIG_FILE = resolve(REPO_ROOT, "config/managed-apps.json");

function loadConfig(): ManagedAppConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as ManagedAppConfig;
  } catch (e) {
    console.error(`[managed-apps] 配置解析失败（忽略托管拉起）: ${String(e)}`);
    return {};
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 锁文件内容里抠 pid：兼容 JSON（{"pid":123}）与纯文本（第一段数字） */
function lockPid(lockFile: string): number | null {
  if (!existsSync(lockFile)) return null;
  try {
    const raw = readFileSync(lockFile, "utf-8").trim();
    try {
      const j = JSON.parse(raw) as { pid?: number };
      if (typeof j.pid === "number") return j.pid;
    } catch { /* 纯文本 */ }
    const m = /\b(\d+)\b/.exec(raw);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** 平台启动时调用：拉起所有 enabled 且未在运行的托管应用（fire-and-forget，不阻塞平台） */
export function startManagedApps(): void {
  const apps = loadConfig().apps ?? [];
  for (const app of apps) {
    if (app.enabled === false) continue;
    const lock = app.lockFile ? resolve(REPO_ROOT, app.lockFile) : undefined;
    if (lock) {
      const pid = lockPid(lock);
      if (pid && pidAlive(pid)) {
        console.log(`[managed-apps] ${app.name} 已在运行 (pid=${pid})，跳过拉起`);
        continue;
      }
    }
    const cwd = resolve(REPO_ROOT, app.cwd);
    const logPath = resolve(REPO_ROOT, app.log ?? `data/managed-${app.name}.log`);
    try {
      const out = openSync(logPath, "a");
      const child = spawn(app.command, app.args ?? [], { cwd, stdio: ["ignore", out, out], detached: true });
      child.unref();
      console.log(`[managed-apps] ${app.name} 已拉起 (pid=${child.pid}, log=${logPath})`);
    } catch (e) {
      console.error(`[managed-apps] ${app.name} 拉起失败: ${String(e)}`);
      try { appendFileSync(logPath, `\n[managed-apps] 拉起失败: ${String(e)}\n`); } catch { /* 忽略 */ }
    }
  }
}
