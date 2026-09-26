/**
 * 应用进程宿主: 大厅应用自带的后端 daemon 统一纳管 (spawn / 停止 / 状态 / 日志)
 *
 * 与 dsh-host.ts 同款模式: 注册表 (app_processes 表) 是事实源, 运行态 Map 只是缓存。
 * 设计要点:
 *  - desired_state 落库为启停事实源: 界面点启动/停止即写库; 平台重启只恢复
 *    desired_state='running' 的应用 —— 明确停止过的应用不会被拉起
 *  - 孤儿收编: 平台重启前被管理的进程可能还活着 (Windows 子进程不随父死),
 *    恢复时先端口探活 / pid 存活检查, 在跑就认领 (adopted), 不双起
 *  - spawn 环境继承平台进程全量 env (含 DSH 插件 env 桥产物, 如 TIMEM_API_KEY),
 *    应用自有 env 同名覆盖 —— 域包插件能力随平台待命, 应用开箱即得
 *  - 崩溃只标记不自动重启 (last_exit_code / last_exited_at 落库, 界面人工处理)
 *  - 停止用 taskkill /T /F 树杀 (shell:true 的子进程是 cmd → node 链)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./admin-modules/context.js";
import { dshStatus } from "./dsh-host.js";
import {
  classifyStatus, decideAdopt, isPidAlive, mergeSpawnEnv,
  pluginReadiness, redactEnv, resolveCwd,
} from "./process-host-core.js";

// src/process-host.ts → ../.. = examples, ../../.. = 仓库根 (相对 cwd 的解析基准)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IS_WIN = process.platform === "win32";
const LOG_MAX = 500; // 每进程内存日志环上限 (行)
const PORT_PROBE_MS = 800;

interface ProcRuntime {
  child: ChildProcess;
  startedAt: number;
  logs: string[];
}

const procs = new Map<string, ProcRuntime>();

// ── DB 访问 ──────────────────────────────────────────────────────

async function getProcRow(appId: string): Promise<any | null> {
  const { rows } = await pool.query("SELECT * FROM app_processes WHERE app_id = $1", [appId]);
  return rows[0] ?? null;
}

// ── 日志环 ───────────────────────────────────────────────────────

function pushLog(rec: ProcRuntime, chunk: string | Buffer): void {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  for (const line of String(chunk).split(/\r?\n/)) {
    const t = line.trimEnd();
    if (!t) continue;
    rec.logs.push(`[${ts}] ${t.slice(0, 2000)}`);
  }
  if (rec.logs.length > LOG_MAX) rec.logs.splice(0, rec.logs.length - LOG_MAX);
}

// ── 探活 ─────────────────────────────────────────────────────────

/** 端口探活: TCP 短连 127.0.0.1:port, 连上即认为服务在听 */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => { sock.destroy(); resolvePromise(v); };
    sock.setTimeout(PORT_PROBE_MS);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** win32: netstat -ano 找监听指定端口的 pid (收编外部进程的树杀目标) */
function findListenerPid(port: number): number | null {
  if (!IS_WIN) return null;
  const r = spawnSync("netstat", ["-ano"], { windowsHide: true, encoding: "utf8" });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // TCP  0.0.0.0:39467  0.0.0.0:0  LISTENING  1234
    if (cols.length >= 5 && cols[3] === "LISTENING" && cols[1] && cols[1].endsWith(":" + port)) {
      const pid = Number(cols[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return null;
}

/** 树杀: win32 taskkill /T /F (cmd→node 链全灭); 其他平台 SIGTERM */
function treeKill(pid: number): boolean {
  try {
    if (IS_WIN) {
      return spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true }).status === 0;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// ── 插件就绪 (域包插件随平台待命的显式依赖面) ────────────────────

function readinessOf(required: string[]): Array<{ name: string; mounted: boolean; error?: string }> {
  return pluginReadiness(required, dshStatus().plugins as Record<string, { error?: string }>);
}

// ── 启动 / 停止 / 状态 ───────────────────────────────────────────

export async function procStart(
  appId: string,
): Promise<{ ok: boolean; error?: string; adopted?: boolean; warnings?: string[] }> {
  const row = await getProcRow(appId);
  if (!row) return { ok: false, error: "该应用尚未注册后端进程" };
  const required = (row.required_plugins ?? []) as string[];
  const warnings = readinessOf(required)
    .filter((r) => !r.mounted)
    .map((r) => `依赖插件「${r.name}」未就绪${r.error ? ` (${r.error})` : ""}, 相关能力可能不可用`);

  // 已被本宿主持有且活着 → 只对齐落库状态
  const rt = procs.get(appId);
  if (rt && rt.child.exitCode === null) {
    await pool.query(
      "UPDATE app_processes SET desired_state='running', updated_at=now() WHERE app_id=$1", [appId]);
    return { ok: true, warnings };
  }

  // 孤儿收编: 端口已在听 (服务级真相) 或 DB pid 仍存活 (无端口配置时的兜底) → 不双起
  const portListening = row.port ? await isPortListening(row.port) : false;
  const pidAlive = !portListening && isPidAlive(row.pid);
  if (decideAdopt({ portListening, pidAlive }) === "adopt") {
    await pool.query(
      "UPDATE app_processes SET desired_state='running', updated_at=now() WHERE app_id=$1", [appId]);
    console.log(`[proc-host] ${appId} 已有实例在跑 (端口=${portListening ? row.port : "pid=" + row.pid}), 收编不双起`);
    return { ok: true, adopted: true, warnings };
  }

  const child = spawn(row.command, {
    cwd: resolveCwd(row.cwd, REPO_ROOT),
    env: mergeSpawnEnv(process.env, row.env ?? {}),
    shell: true,
    windowsHide: true,
  });
  const rec: ProcRuntime = { child, startedAt: Date.now(), logs: [] };
  procs.set(appId, rec);
  pushLog(rec, `[host] 启动: ${row.command} (cwd=${row.cwd || "."}, pid=${child.pid ?? "?"})`);
  child.stdout?.on("data", (c) => pushLog(rec, c));
  child.stderr?.on("data", (c) => pushLog(rec, c));
  child.on("error", (e) => pushLog(rec, `[host] spawn 失败: ${e.message}`));
  child.on("exit", (code, signal) => {
    pushLog(rec, `[host] 进程退出 code=${code ?? "-"} signal=${signal ?? "-"}`);
    procs.delete(appId);
    // 只标记不重启: 退出码/时间落库, desired_state 保持原值 (running + 非零退出 = 界面标红人工处理)
    void pool.query(
      "UPDATE app_processes SET last_exit_code=$2, last_exited_at=now(), pid=NULL, updated_at=now() WHERE app_id=$1",
      [appId, code ?? null],
    ).catch(() => {});
  });
  await pool.query(
    `UPDATE app_processes SET desired_state='running', pid=$2, last_exit_code=NULL,
     last_started_at=now(), updated_at=now() WHERE app_id=$1`,
    [appId, child.pid ?? null],
  );
  console.log(`[proc-host] ${appId} 已拉起 (pid=${child.pid ?? "?"})${warnings.length ? " ⚠ " + warnings.join("; ") : ""}`);
  return { ok: true, warnings };
}

export async function procStop(appId: string): Promise<{ ok: boolean; error?: string; wasRunning?: boolean }> {
  const row = await getProcRow(appId);
  if (!row) return { ok: false, error: "该应用尚未注册后端进程" };
  // 先落库 desired=stopped: 即使进程杀不干净, 平台重启也不会再拉起
  await pool.query(
    "UPDATE app_processes SET desired_state='stopped', pid=NULL, updated_at=now() WHERE app_id=$1",
    [appId],
  );
  let wasRunning = false;
  const rt = procs.get(appId);
  if (rt?.child.pid && rt.child.exitCode === null) {
    wasRunning = treeKill(rt.child.pid);
  } else if (row.port) {
    // 外部/收编态: 按端口找 pid 树杀 (不认识的进程也是这个应用占的端口)
    const pid = findListenerPid(row.port);
    if (pid) wasRunning = treeKill(pid);
  }
  if (rt) { try { rt.child.kill(); } catch { /* 已退出 */ } }
  procs.delete(appId);
  console.log(`[proc-host] ${appId} 已停止${wasRunning ? "" : " (原本就没在跑)"}`);
  return { ok: true, wasRunning };
}

export async function procUnregister(appId: string): Promise<{ ok: boolean; error?: string }> {
  const stop = await procStop(appId);
  if (!stop.ok) return stop;
  await pool.query("DELETE FROM app_processes WHERE app_id=$1", [appId]);
  return { ok: true };
}

export async function procLogs(appId: string, lines = 200): Promise<string[]> {
  const rec = procs.get(appId);
  return rec ? rec.logs.slice(-lines) : [];
}

/** 单应用状态 payload (GET /app/hall/manage/proc) */
export async function procInfo(appId: string): Promise<Record<string, unknown>> {
  const row = await getProcRow(appId);
  if (!row) return { registered: false, status: "unregistered" };
  const required = (row.required_plugins ?? []) as string[];
  const rt = procs.get(appId);
  const portListening = row.port ? await isPortListening(row.port) : false;
  const status = classifyStatus({
    childAlive: Boolean(rt && rt.child.exitCode === null),
    portListening,
    pidAlive: !portListening && isPidAlive(row.pid),
    desiredState: row.desired_state,
  });
  return {
    registered: true,
    status,
    desiredState: row.desired_state,
    command: row.command,
    cwd: row.cwd,
    port: row.port,
    env: redactEnv(row.env ?? {}),
    requiredPlugins: required,
    pluginReadiness: readinessOf(required),
    pid: row.pid,
    lastExitCode: row.last_exit_code,
    lastStartedAt: row.last_started_at,
    lastExitedAt: row.last_exited_at,
  };
}

// ── 平台启动恢复 ─────────────────────────────────────────────────

/** initAppBackend 末尾调用 (必须在 DSH 插件装载之后 —— 保住"插件先待命, 应用后拉起"的时序) */
export async function recoverAppProcesses(): Promise<void> {
  const { rows } = await pool.query(
    "SELECT app_id FROM app_processes WHERE desired_state = 'running'");
  for (const r of rows) {
    try {
      const r2 = await procStart(r.app_id);
      if (r2.ok) console.log(`[proc-host] 恢复 ${r.app_id}${r2.adopted ? " (收编既有实例)" : ""}`);
    } catch (e: any) {
      console.warn(`[proc-host] 恢复 ${r.app_id} 失败(忽略):`, e?.message ?? e);
    }
  }
}
