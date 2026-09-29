/**
 * 智悦平台 · 项目小助理（feishu-task-loop）进程管理器
 *
 * 管理被监控进程 examples/feishu-task-loop（飞书「项目小助理」机器人）：
 *   - 启动：spawn `pnpm --filter feishu-task-loop start`（cwd=仓库根），日志追加到
 *     examples/feishu-task-loop/bot.stdout.log / bot.stderr.log
 *   - 停止：SIGTERM（进程内优雅退出）→ 最多 ~8s → SIGKILL
 *   - 单实例锁：/tmp/aigility-feishu-task-loop.lock（内容=pid，env TASK_LOOP_LOCK_PATH 可覆盖）；
 *     锁存在但 pid 已死 = stale，视作 stopped（下次启动自愈接管）
 *   - 配置持久化：examples/aigility-platform/data/task-loop.json；当前版本在 start 时
 *     把配置注入子进程 env（TASK_ASSISTANT_MODEL / TASK_PIPELINE_INTERVAL_MS /
 *     TASK_AUTO_DISPATCH / featureFlags 展开为 TASK_FLAG_<KEY>），运行中进程不热加载，
 *     保存配置后需重启才生效
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 仓库根（pnpm --filter 的工作目录） */
const REPO_ROOT = resolve(__dirname, "../../..");
/** 被管模块目录（日志文件所在） */
const TASK_LOOP_DIR = resolve(__dirname, "../../feishu-task-loop");
const STDOUT_LOG = resolve(TASK_LOOP_DIR, "bot.stdout.log");
const STDERR_LOG = resolve(TASK_LOOP_DIR, "bot.stderr.log");

const lockPath = (): string =>
  process.env.TASK_LOOP_LOCK_PATH ?? "/tmp/aigility-feishu-task-loop.lock";

// ── 配置持久化（对齐 role-registry 的落盘模式）──────────────────

export interface TaskLoopConfig {
  /** LLM 兜底模型（注入 TASK_ASSISTANT_MODEL） */
  llmModel?: string;
  /** 流水线轮询间隔 ms（注入 TASK_PIPELINE_INTERVAL_MS） */
  pipelineIntervalMs?: number;
  /** 自动派发开关（注入 TASK_AUTO_DISPATCH=1/0） */
  autoDispatch?: boolean;
  /** 通知开关（注入 TASK_NOTIFY_ENABLED=1/0） */
  notifyEnabled?: boolean;
  /** 飞书应用 App ID（注入 FEISHU_APP_ID，覆盖仓库 .env；为空沿用 .env） */
  feishuAppId?: string;
  /** 飞书应用 App Secret（注入 FEISHU_APP_SECRET；读取接口只回掩码，不回原文） */
  feishuAppSecret?: string;
  /** 播报目标群 chatId（注入 TASK_NOTIFY_CHAT_ID；配置后所有静默收集播报只发该群） */
  notifyChatId?: string;
  /** 播报目标群名称（仅页面回显用） */
  notifyChatName?: string;
  /** 功能开关：动态 key-value（注入 TASK_FLAG_<大写KEY>=1/0） */
  featureFlags: Record<string, boolean>;
  /** 透传子进程的自定义 env 键值 */
  env: Record<string, string>;
}

const CONFIG_FILE = resolve(__dirname, "../data/task-loop.json");

const DEFAULT_CONFIG: TaskLoopConfig = { featureFlags: {}, env: {} };

export function loadTaskLoopConfig(): TaskLoopConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG, featureFlags: {}, env: {} };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<TaskLoopConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      featureFlags: raw.featureFlags ?? {},
      env: raw.env ?? {},
    };
  } catch (e) {
    console.warn("[task-loop] 配置读取失败（返回默认值，不覆盖文件）:", e);
    return { ...DEFAULT_CONFIG, featureFlags: {}, env: {} };
  }
}

function persistConfig(doc: TaskLoopConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

/** 校验并规整配置；返回错误消息或 null（通过） */
export function validateTaskLoopConfig(input: Partial<TaskLoopConfig>): string | null {
  if (input.llmModel !== undefined && typeof input.llmModel !== "string") return "llmModel 必须是字符串";
  if (input.pipelineIntervalMs !== undefined) {
    if (typeof input.pipelineIntervalMs !== "number" || !Number.isFinite(input.pipelineIntervalMs) || input.pipelineIntervalMs < 0) {
      return "pipelineIntervalMs 必须是非负数字（毫秒）";
    }
  }
  for (const k of ["autoDispatch", "notifyEnabled"] as const) {
    if (input[k] !== undefined && typeof input[k] !== "boolean") return `${k} 必须是布尔值`;
  }
  for (const k of ["feishuAppId", "feishuAppSecret", "notifyChatId", "notifyChatName"] as const) {
    if (input[k] !== undefined && typeof input[k] !== "string") return `${k} 必须是字符串`;
  }
  if (typeof input.feishuAppId === "string" && input.feishuAppId && !/^cli_[a-z0-9]+$/i.test(input.feishuAppId.trim())) {
    return "feishuAppId 应为 cli_ 开头的飞书应用 App ID";
  }
  if (typeof input.notifyChatId === "string" && input.notifyChatId && !/^oc_[a-f0-9]+$/i.test(input.notifyChatId.trim())) {
    return "notifyChatId 应为 oc_ 开头的飞书群 chatId";
  }
  if (input.featureFlags !== undefined) {
    if (typeof input.featureFlags !== "object" || input.featureFlags === null || Array.isArray(input.featureFlags)) {
      return "featureFlags 必须是对象";
    }
    for (const [k, v] of Object.entries(input.featureFlags)) {
      if (!/^[\w.-]{1,64}$/.test(k)) return `featureFlags 键 "${k}" 只允许字母数字._-（1-64 位）`;
      if (typeof v !== "boolean") return `featureFlags["${k}"] 必须是布尔值`;
    }
  }
  if (input.env !== undefined) {
    if (typeof input.env !== "object" || input.env === null || Array.isArray(input.env)) return "env 必须是对象";
    for (const [k, v] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `env 键 "${k}" 不是合法环境变量名`;
      if (typeof v !== "string") return `env["${k}"] 必须是字符串`;
    }
  }
  return null;
}

export function saveTaskLoopConfig(input: Partial<TaskLoopConfig>): TaskLoopConfig {
  const problem = validateTaskLoopConfig(input);
  if (problem) throw new Error(problem);
  const doc = loadTaskLoopConfig();
  const next: TaskLoopConfig = { ...doc };
  if (input.llmModel !== undefined) next.llmModel = input.llmModel.trim() || undefined;
  if (input.pipelineIntervalMs !== undefined) next.pipelineIntervalMs = input.pipelineIntervalMs;
  if (input.autoDispatch !== undefined) next.autoDispatch = input.autoDispatch;
  if (input.notifyEnabled !== undefined) next.notifyEnabled = input.notifyEnabled;
  if (input.feishuAppId !== undefined) next.feishuAppId = input.feishuAppId.trim() || undefined;
  if (input.feishuAppSecret !== undefined && input.feishuAppSecret !== SECRET_MASK) {
    next.feishuAppSecret = input.feishuAppSecret.trim() || undefined;
  }
  if (input.notifyChatId !== undefined) next.notifyChatId = input.notifyChatId.trim() || undefined;
  if (input.notifyChatName !== undefined) next.notifyChatName = input.notifyChatName.trim() || undefined;
  if (input.featureFlags !== undefined) next.featureFlags = { ...input.featureFlags };
  if (input.env !== undefined) next.env = { ...input.env };
  persistConfig(next);
  return next;
}

/** start 时把配置翻译为子进程 env（运行中进程不热加载，需重启生效） */
function configEnv(cfg: TaskLoopConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.llmModel) env.TASK_ASSISTANT_MODEL = cfg.llmModel;
  if (cfg.pipelineIntervalMs !== undefined) env.TASK_PIPELINE_INTERVAL_MS = String(Math.round(cfg.pipelineIntervalMs));
  if (cfg.autoDispatch !== undefined) env.TASK_AUTO_DISPATCH = cfg.autoDispatch ? "1" : "0";
  if (cfg.notifyEnabled !== undefined) env.TASK_NOTIFY_ENABLED = cfg.notifyEnabled ? "1" : "0";
  // 飞书接入：页面配置优先于仓库 .env（子进程的 loadEnv 不覆盖已存在的 env 键）
  if (cfg.feishuAppId) env.FEISHU_APP_ID = cfg.feishuAppId;
  if (cfg.feishuAppSecret) env.FEISHU_APP_SECRET = cfg.feishuAppSecret;
  if (cfg.notifyChatId) env.TASK_NOTIFY_CHAT_ID = cfg.notifyChatId;
  for (const [k, v] of Object.entries(cfg.featureFlags)) {
    env[`TASK_FLAG_${k.replace(/[^\w]/g, "_").toUpperCase()}`] = v ? "1" : "0";
  }
  return { ...env, ...cfg.env };
}

// ── 飞书接入（页面可视化配置的支撑：凭配置凭证枚举机器人所在群）──

/** 秘密掩码：PUT 时收到该值表示「不修改已保存的 Secret」；GET 时原文以此掩码返回 */
export const SECRET_MASK = "******";

export function maskSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return secret.length <= 10 ? SECRET_MASK : `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

/** 面向前端展示的配置视图（Secret 只回掩码） */
export function taskLoopConfigView(cfg: TaskLoopConfig): TaskLoopConfig & { feishuAppSecretMasked?: string } {
  return {
    ...cfg,
    ...(cfg.feishuAppSecret ? { feishuAppSecret: SECRET_MASK, feishuAppSecretMasked: maskSecret(cfg.feishuAppSecret) } : {}),
  };
}

export interface FeishuChatItem {
  chatId: string;
  name: string;
}

/**
 * 枚举机器人所在的飞书群（im/v1/chats），供页面下拉选择「机器人群」。
 * 凭证优先级：显式传入 > 已保存配置 > 仓库 .env（子进程同源语义由调用方保证）。
 */
export async function listFeishuChats(override?: { appId?: string; appSecret?: string }): Promise<{ ok: boolean; chats: FeishuChatItem[]; error?: string }> {
  const cfg = loadTaskLoopConfig();
  const appId = override?.appId?.trim() || cfg.feishuAppId || readEnvValue("FEISHU_APP_ID");
  const appSecret = override?.appSecret?.trim() || cfg.feishuAppSecret || readEnvValue("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    return { ok: false, chats: [], error: "缺少凭证：请先填写并保存 App ID / App Secret" };
  }
  try {
    const tokenResp = (await fetchJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })) as { code?: number; msg?: string; tenant_access_token?: string };
    if (tokenResp.code !== 0 || !tokenResp.tenant_access_token) {
      return { ok: false, chats: [], error: `获取 tenant_access_token 失败（code=${tokenResp.code}）：${tokenResp.msg ?? "未知错误"}` };
    }
    const chatsResp = (await fetchJson("https://open.feishu.cn/open-apis/im/v1/chats?page_size=50", {
      headers: { Authorization: `Bearer ${tokenResp.tenant_access_token}` },
    })) as { code?: number; msg?: string; data?: { items?: Array<{ chat_id?: string; name?: string }> } };
    if (chatsResp.code !== 0) {
      return { ok: false, chats: [], error: `获取群列表失败（code=${chatsResp.code}）：${chatsResp.msg ?? "未知错误"}` };
    }
    const chats = (chatsResp.data?.items ?? [])
      .filter((i) => i.chat_id)
      .map((i) => ({ chatId: i.chat_id as string, name: i.name ?? "(未命名群)" }));
    return { ok: true, chats };
  } catch (e) {
    return { ok: false, chats: [], error: `请求飞书开放平台失败：${String(e)}` };
  }
}

/** 读取仓库根 .env 的单个键（与被管模块 loadEnv 同源，不含 export 前缀/引号处理从简） */
function readEnvValue(key: string): string | undefined {
  try {
    const content = readFileSync(resolve(REPO_ROOT, ".env"), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim();
    }
  } catch { /* 无 .env */ }
  return undefined;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, init);
  return (await resp.json()) as unknown;
}

// ── 进程状态 ────────────────────────────────────────────────────

export type TaskLoopState = "running" | "stopped" | "stale";

export interface LockInfo {
  exists: boolean;
  pid?: number;
  path: string;
  stale: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // EPERM=存在但无权发信号
  }
}

export function readLock(): LockInfo {
  const path = lockPath();
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return { exists: true, path, stale: true };
    return { exists: true, pid, path, stale: !pidAlive(pid) };
  } catch {
    return { exists: false, path, stale: false };
  }
}

/** 缓存的子进程句柄（仅本平台进程亲手 spawn 的实例） */
let child: ChildProcess | null = null;

function stateFromLock(lock: LockInfo): TaskLoopState {
  if (lock.exists && !lock.stale) return "running";
  if (lock.exists && lock.stale) return "stale";
  return "stopped";
}

export interface LogTail {
  file: string;
  lines: string[];
}

function tailFile(file: string, n: number): LogTail {
  if (!existsSync(file)) return { file, lines: [] };
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    // 丢掉可能不完整的最后一行（无结尾换行时）
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { file, lines: lines.slice(-n) };
  } catch (e) {
    return { file, lines: [`[读取失败: ${String(e)}]`] };
  }
}

export interface TaskLoopStatus {
  state: TaskLoopState;
  pid?: number;
  lock: LockInfo;
  managedByPlatform: boolean;
  logs: { stdout: LogTail; stderr: LogTail };
  config: TaskLoopConfig;
}

export function taskLoopStatus(tailLines = 30): TaskLoopStatus {
  const lock = readLock();
  return {
    state: stateFromLock(lock),
    pid: lock.pid,
    lock,
    managedByPlatform: child !== null && !child.killed,
    logs: { stdout: tailFile(STDOUT_LOG, tailLines), stderr: tailFile(STDERR_LOG, tailLines) },
    config: loadTaskLoopConfig(),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 启动 / 停止 ─────────────────────────────────────────────────

export class TaskLoopError extends Error {}

/** 解析 pnpm 可执行文件的绝对路径（spawn 推荐 absolute；找不到就回退 "pnpm" 交给 PATH） */
function pnpmBin(): string {
  const candidates = [
    process.env.PNPM_HOME ? resolve(process.env.PNPM_HOME, "pnpm") : "",
    process.env.PNPM_HOME ? resolve(process.env.PNPM_HOME, "pnpm.cmd") : "",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "pnpm";
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  state: TaskLoopState;
  message: string;
}

/** 启动 feishu-task-loop（锁不存在或 stale 才允许）；启动后轮询探活确认 */
export async function startTaskLoop(timeoutMs = 12000): Promise<StartResult> {
  const lock = readLock();
  if (lock.exists && !lock.stale) {
    return { ok: false, pid: lock.pid, state: "running", message: `已在运行（pid ${lock.pid}），无需重复启动` };
  }
  if (lock.exists && lock.stale) {
    // stale 锁：被管模块的 acquireSingletonLock 自带僵锁自愈，这里直接放行启动
    console.log(`[task-loop] 发现 stale 锁（pid ${lock.pid} 已死），放行重新启动`);
  }

  const cfg = loadTaskLoopConfig();
  const out = appendHandle(STDOUT_LOG);
  const err = appendHandle(STDERR_LOG);
  let proc: ChildProcess;
  try {
    proc = spawn(pnpmBin(), ["--filter", "feishu-task-loop", "start"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", out, err],
      env: { ...process.env, ...configEnv(cfg) },
      detached: false,
    });
  } catch (e) {
    closeSync(out); closeSync(err);
    throw new TaskLoopError(`启动失败：${String(e)}`);
  }
  child = proc;
  const spawnPid = proc.pid;
  console.log(`[task-loop] 已发起启动（pid ${spawnPid}），日志 → ${STDOUT_LOG}`);

  proc.on("exit", (code, signal) => {
    console.log(`[task-loop] 子进程退出 code=${code} signal=${signal}`);
    if (child === proc) child = null;
    closeSync(out); closeSync(err);
  });
  proc.on("error", (e) => {
    console.error("[task-loop] 子进程错误:", e);
    if (child === proc) child = null;
  });

  // 轮询探活：等锁文件出现且 pid 存活，或子进程提前退出则报错
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(600);
    if (child !== proc) {
      const s = taskLoopStatus(5);
      return { ok: false, state: s.state, message: "子进程启动后立即退出，请查看 stderr 日志" };
    }
    const cur = readLock();
    if (cur.exists && !cur.stale) {
      return { ok: true, pid: cur.pid, state: "running", message: `启动成功（pid ${cur.pid}）` };
    }
  }
  const s = taskLoopStatus(5);
  return {
    ok: Boolean(spawnPid) && s.state === "running",
    pid: s.pid,
    state: s.state,
    message: s.state === "running" ? "启动成功" : `启动超时（${timeoutMs}ms 内未见单实例锁就绪），请查看日志`,
  };
}

function appendHandle(file: string): number {
  return openSync(file, "a");
}

export interface StopResult {
  ok: boolean;
  state: TaskLoopState;
  message: string;
  forced?: boolean;
}

/** 停止：SIGTERM → 轮询最多 ~8s → SIGKILL；优先缓存句柄，否则按锁 pid */
export async function stopTaskLoop(timeoutMs = 8000): Promise<StopResult> {
  let pid: number | undefined;
  let viaChild = false;
  if (child && !child.killed && child.pid) {
    pid = child.pid;
    viaChild = true;
  } else {
    const lock = readLock();
    if (!lock.exists) return { ok: true, state: "stopped", message: "未在运行（无单实例锁）" };
    if (lock.stale) {
      return { ok: true, state: "stale", message: `锁存在但 pid ${lock.pid} 已死（stale），视作已停止；下次启动将自愈接管` };
    }
    pid = lock.pid;
  }

  const sig = (sigName: NodeJS.Signals) => {
    try {
      if (viaChild) child?.kill(sigName);
      else process.kill(pid!, sigName);
    } catch { /* 进程可能刚好退出 */ }
  };

  sig("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!pidAlive(pid!)) {
      if (child) { child = null; }
      return { ok: true, state: "stopped", message: `已优雅停止（pid ${pid}，SIGTERM）` };
    }
  }
  sig("SIGKILL");
  await sleep(500);
  const dead = !pidAlive(pid!);
  if (child) child = null;
  return dead
    ? { ok: true, state: "stopped", message: `SIGTERM 超时，已强制杀死（pid ${pid}，SIGKILL）`, forced: true }
    : { ok: false, state: "running", message: `停止失败：SIGKILL 后 pid ${pid} 仍存活，请人工介入` };
}

/** 重启 = 停止（若在跑）→ 启动 */
export async function restartTaskLoop(): Promise<StartResult & { stoppedFirst: StopResult | null }> {
  const before = taskLoopStatus(0);
  let stoppedFirst: StopResult | null = null;
  if (before.state === "running") {
    stoppedFirst = await stopTaskLoop();
    if (!stoppedFirst.ok) {
      return { ok: false, state: before.state, stoppedFirst, message: `重启中止：停止失败 —— ${stoppedFirst.message}` };
    }
  } else if (before.state === "stale") {
    // stale 锁交由启动自愈，无需单独清理
  }
  return { ...(await startTaskLoop()), stoppedFirst };
}

/** 读取日志尾部（供 GET /logs?tail=N） */
export function taskLoopLogs(tail = 200): { stdout: LogTail; stderr: LogTail } {
  const n = Math.max(1, Math.min(1000, Math.floor(tail) || 200));
  return { stdout: tailFile(STDOUT_LOG, n), stderr: tailFile(STDERR_LOG, n) };
}
