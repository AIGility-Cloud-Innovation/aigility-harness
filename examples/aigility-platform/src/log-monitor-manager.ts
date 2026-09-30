/**
 * 智悦平台 · 日志监察员（log-monitor）管理器
 *
 * 把 examples/apps/log-monitor-daemon.js（日志监察守护进程）收编为平台内可管理模块：
 *   - 被管进程：`node examples/apps/log-monitor-daemon.js`（零依赖，默认 API :39467）
 *   - 状态：优先探测 daemon 自带 HTTP API（GET /status），在线即 running；
 *     离线时看是否有本平台亲手 spawn 的子进程存活
 *   - 配置读写：直接代理 daemon 的 GET/PUT /config（webhook / keywords / autos），
 *     daemon 落盘 log-monitor-daemon-config.json 并即时生效（自动触发一次检查）
 *   - 日志：examples/apps/log-monitor-daemon.stdout.log / .stderr.log（平台 spawn 时重定向）
 *
 * 与「团队记忆总结」同构：页面（LogMonitorPage）— harness.ts — /api/aigility/log-monitor/* — 本管理器
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 被管模块目录（daemon 脚本与配置/状态文件所在） */
const APPS_DIR = resolve(__dirname, "../../apps");
const DAEMON_SCRIPT = resolve(APPS_DIR, "log-monitor-daemon.js");
const STDOUT_LOG = resolve(APPS_DIR, "log-monitor-daemon.stdout.log");
const STDERR_LOG = resolve(APPS_DIR, "log-monitor-daemon.stderr.log");

const daemonPort = (): number =>
  Number.parseInt(process.env.LOGMON_PORT ?? "39467", 10) || 39467;

// ── daemon HTTP API 代理 ─────────────────────────────────────────

function daemonRequest<T>(path: string, method: "GET" | "PUT", body?: unknown): Promise<T> {
  return new Promise((resolveReq, rejectReq) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: daemonPort(),
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolveReq(JSON.parse(data) as T);
          } catch {
            rejectReq(new Error(`daemon 返回非 JSON（HTTP ${res.statusCode}）`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon 请求超时（5s）")));
    req.on("error", (e) => rejectReq(e));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 类型（与 harness.ts / LogMonitorPage 对齐）──────────────────

export interface LogMonitorAuto {
  id?: string;
  host: string;
  p: string;
  s?: string;
  n?: number;
  interval?: number;
  on?: boolean;
  /** daemon /status 运行时字段 */
  checking?: boolean;
  lastAt?: number;
  lastErr?: string;
}

export interface LogMonitorDaemonStatus {
  pid: number
  startedAt: number
  checkCount: number
  time: number
  autos: LogMonitorAuto[]
  errs: { t: string; src: string; line: string }[]
}

export interface LogMonitorDaemonConfig {
  webhook: string
  keywords: string
  autos: LogMonitorAuto[]
}

export type LogMonitorState = "running" | "stopped";

export interface LogMonitorStatus {
  state: LogMonitorState
  port: number
  managedByPlatform: boolean
  daemon: LogMonitorDaemonStatus | null
  config: LogMonitorDaemonConfig | null
  error?: string
}

export async function fetchLogMonitorStatus(errsLimit = 20): Promise<LogMonitorStatus> {
  const status: LogMonitorStatus = {
    state: "stopped",
    port: daemonPort(),
    managedByPlatform: child !== null && !child.killed,
    daemon: null,
    config: null,
  };
  try {
    status.daemon = await daemonRequest<LogMonitorDaemonStatus>(
      `/status?errs=${Math.min(100, Math.max(1, errsLimit))}`,
      "GET",
    );
    status.state = "running";
    try {
      status.config = (await daemonRequest<{ ok: boolean; cfg: LogMonitorDaemonConfig }>("/config", "GET")).cfg;
    } catch {
      /* 状态在线但配置读取失败时保留 daemon 状态，config 置空由页面提示 */
    }
  } catch (e) {
    status.error = String((e as Error).message ?? e);
  }
  return status;
}

export async function fetchLogMonitorConfig(): Promise<LogMonitorDaemonConfig> {
  const j = await daemonRequest<{ ok: boolean; cfg: LogMonitorDaemonConfig }>("/config", "GET");
  return j.cfg;
}

/** 下发配置到运行中的 daemon（daemon 落盘并即时生效，开启中的自动化会立即检查一次） */
export async function saveLogMonitorConfig(cfg: Partial<LogMonitorDaemonConfig>): Promise<LogMonitorDaemonConfig> {
  const body: Record<string, unknown> = {};
  if (typeof cfg.webhook === "string") body.webhook = cfg.webhook;
  if (typeof cfg.keywords === "string" && cfg.keywords.trim()) body.keywords = cfg.keywords.trim();
  if (Array.isArray(cfg.autos)) body.autos = cfg.autos;
  await daemonRequest<{ ok: boolean }>("/config", "PUT", body);
  return fetchLogMonitorConfig();
}

export interface LogMonitorLogTail {
  file: string
  lines: string[]
}

function tailFile(file: string, maxLines: number): LogMonitorLogTail {
  if (!existsSync(file)) return { file, lines: [] };
  try {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
    return { file, lines: lines.slice(-maxLines) };
  } catch {
    return { file, lines: [] };
  }
}

export function logMonitorLogs(maxLines = 200): { stdout: LogMonitorLogTail; stderr: LogMonitorLogTail } {
  const n = Math.min(1000, Math.max(1, maxLines));
  return { stdout: tailFile(STDOUT_LOG, n), stderr: tailFile(STDERR_LOG, n) };
}

// ── 进程启停（模式对齐 task-loop-manager，但无单实例锁：以 API 在线为准）────

let child: ChildProcess | null = null;

export interface LogMonitorStartResult {
  ok: boolean
  state: LogMonitorState
  pid?: number
  message: string
}

export async function startLogMonitor(timeoutMs = 10000): Promise<LogMonitorStartResult> {
  // 已在线（可能是用户手动起的）直接返回
  const before = await fetchLogMonitorStatus();
  if (before.state === "running") {
    return { ok: true, state: "running", pid: before.daemon?.pid, message: "已在运行（API 在线）" };
  }
  if (!existsSync(DAEMON_SCRIPT)) {
    return { ok: false, state: "stopped", message: `找不到 ${DAEMON_SCRIPT}` };
  }
  try {
    mkdirSync(APPS_DIR, { recursive: true });
    const out = openSync(STDOUT_LOG, "a");
    const err = openSync(STDERR_LOG, "a");
    const proc = spawn(process.execPath, [DAEMON_SCRIPT], {
      cwd: APPS_DIR,
      env: process.env,
      detached: false,
      stdio: ["ignore", out, err],
    });
    closeSync(out);
    closeSync(err);
    child = proc;
    console.log(`[log-monitor] 已发起启动（pid ${proc.pid}），日志 → ${STDOUT_LOG}`);
    const onExit = () => { if (child === proc) child = null; };
    proc.on("exit", onExit);
    proc.on("error", onExit);
  } catch (e) {
    child = null;
    return { ok: false, state: "stopped", message: `启动失败：${String(e)}` };
  }
  // 等待 API 就绪
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await fetchLogMonitorStatus();
    if (s.state === "running") {
      return { ok: true, state: "running", pid: s.daemon?.pid, message: "已启动（API 就绪）" };
    }
  }
  return { ok: false, state: "stopped", message: `启动后 ${timeoutMs / 1000}s 内 API 未就绪（详见日志）` };
}

export interface LogMonitorStopResult {
  ok: boolean
  state: LogMonitorState
  message: string
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopLogMonitor(timeoutMs = 8000): Promise<LogMonitorStopResult> {
  // 优先探测 daemon 真实 pid（平台 spawn 的可能经中间层，API pid 更可靠）
  const s = await fetchLogMonitorStatus();
  if (s.state !== "running") {
    child = null;
    return { ok: true, state: "stopped", message: "未在运行（API 不在线）" };
  }
  const pid = s.daemon?.pid;
  if (!pid || !Number.isFinite(pid)) {
    return { ok: false, state: "running", message: "无法获取 daemon pid，未执行停止" };
  }
  const viaChild = child !== null && child.pid === pid;
  try {
    viaChild ? child?.kill("SIGTERM") : process.kill(pid, "SIGTERM");
  } catch (e) {
    return { ok: false, state: "running", message: `发送 SIGTERM 失败：${String(e)}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!(await pidAlive(pid))) {
      if (child) child = null;
      return { ok: true, state: "stopped", message: `已优雅停止（pid ${pid}，SIGTERM）` };
    }
  }
  try {
    viaChild ? child?.kill("SIGKILL") : process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500));
  const alive = await pidAlive(pid);
  if (child) child = null;
  return alive
    ? { ok: false, state: "running", message: `SIGTERM/SIGKILL 后 pid ${pid} 仍存活` }
    : { ok: true, state: "stopped", message: `SIGTERM 超时，已强制杀死（pid ${pid}，SIGKILL）` };
}

export async function restartLogMonitor(): Promise<LogMonitorStartResult & { stoppedFirst: LogMonitorStopResult | null }> {
  const before = await fetchLogMonitorStatus();
  let stoppedFirst: LogMonitorStopResult | null = null;
  if (before.state === "running") {
    stoppedFirst = await stopLogMonitor();
    if (!stoppedFirst.ok) {
      return { ok: false, state: "running", stoppedFirst, message: `重启中止：停止失败 —— ${stoppedFirst.message}` };
    }
  }
  return { ...(await startLogMonitor()), stoppedFirst };
}
