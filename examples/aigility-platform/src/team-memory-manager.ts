/**
 * 智悦平台 · 团队记忆总结（team-memory）管理器
 *
 * 把 examples/team-memory-console 已有的「日报 / 晨报」总结能力收编为平台内可配置模块
 * （与「项目小助理」task-loop-manager 同构）：
 *   - 配置持久化：examples/aigility-platform/data/team-memory.json
 *   - 调度：进程内定时器按 HH:MM 触发日报（默认 18:30）/ 晨报（默认 08:30），每类每天最多一次
 *   - 执行：spawn `pnpm --filter team-memory-console cli report|morning --send`，
 *     配置翻译为子进程 env（TIMEM_API_KEY / FEISHU_* / LITELLM_* / REPORT_SUMMARY_MODEL 等）；
 *     子进程自身 loadEnvFiles 会兜底加载仓库 .env，且不覆盖已注入的 env —— 页面配置优先
 *   - 日志：examples/team-memory-console/report.stdout.log / report.stderr.log
 *   - 运行历史：data/team-memory-runs.json（保留最近 50 条）
 *
 * 注意：凭证只回掩码不回原文（SECRET_MASK，与 task-loop 同语义）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const MODULE_DIR = resolve(__dirname, "../../team-memory-console");
const STDOUT_LOG = resolve(MODULE_DIR, "report.stdout.log");
const STDERR_LOG = resolve(MODULE_DIR, "report.stderr.log");
const CONFIG_FILE = resolve(__dirname, "../data/team-memory.json");
const RUNS_FILE = resolve(__dirname, "../data/team-memory-runs.json");

// ── 配置持久化 ──────────────────────────────────────────────────

export interface TeamMemoryJobConfig {
  /** 调度总开关（关闭后到点不触发，手动「立即生成」仍可用） */
  enabled: boolean;
  /** 日报触发时刻 HH:MM（本地时区），默认 18:30 */
  dailyReportTime: string;
  /** 晨报触发时刻 HH:MM，默认 08:30 */
  morningReportTime: string;
  /** TiMEM 云 API Key（注入 TIMEM_API_KEY；读取接口只回掩码） */
  timemApiKey?: string;
  /** TiMEM API 基础 URL（默认 https://api.timem.cloud） */
  timemBaseUrl?: string;
  /** 飞书 App ID（注入 FEISHU_APP_ID；留空沿用仓库 .env） */
  feishuAppId?: string;
  /** 飞书 App Secret（注入 FEISHU_APP_SECRET；只回掩码） */
  feishuAppSecret?: string;
  /** 推送群 chatId（注入 FEISHU_REPORT_CHAT_ID） */
  reportChatId?: string;
  /** 推送群名称（仅页面回显） */
  reportChatName?: string;
  /** LLM 网关地址（注入 LITELLM_URL；留空沿用 .env，缺省则日报回退逐条罗列） */
  litellmUrl?: string;
  /** LLM 网关 Key（注入 LITELLM_KEY；只回掩码） */
  litellmKey?: string;
  /** 摘要模型（注入 REPORT_SUMMARY_MODEL） */
  summaryModel?: string;
  /** 透传子进程的自定义 env 键值 */
  env: Record<string, string>;
}

export type TeamMemoryJobKind = "report" | "morning";

const DEFAULT_CONFIG: TeamMemoryJobConfig = {
  enabled: false,
  dailyReportTime: "18:30",
  morningReportTime: "08:30",
  env: {},
};

export function loadTeamMemoryConfig(): TeamMemoryJobConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG, env: {} };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<TeamMemoryJobConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      enabled: raw.enabled ?? false,
      env: raw.env ?? {},
    };
  } catch (e) {
    console.warn("[team-memory] 配置读取失败（返回默认值，不覆盖文件）:", e);
    return { ...DEFAULT_CONFIG, env: {} };
  }
}

function persistConfig(doc: TeamMemoryJobConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 校验并规整配置；返回错误消息或 null（通过） */
export function validateTeamMemoryConfig(input: Partial<TeamMemoryJobConfig>): string | null {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return "enabled 必须是布尔值";
  for (const k of ["dailyReportTime", "morningReportTime"] as const) {
    if (input[k] !== undefined && !HHMM.test(input[k] as string)) return `${k} 必须是 HH:MM（24 小时制）`;
  }
  for (const k of ["timemApiKey", "timemBaseUrl", "feishuAppId", "feishuAppSecret", "reportChatId", "reportChatName", "litellmUrl", "litellmKey", "summaryModel"] as const) {
    if (input[k] !== undefined && typeof input[k] !== "string") return `${k} 必须是字符串`;
  }
  if (typeof input.feishuAppId === "string" && input.feishuAppId && !/^cli_[a-z0-9]+$/i.test(input.feishuAppId.trim())) {
    return "feishuAppId 应为 cli_ 开头的飞书应用 App ID";
  }
  if (typeof input.reportChatId === "string" && input.reportChatId && !/^oc_[a-f0-9]+$/i.test(input.reportChatId.trim())) {
    return "reportChatId 应为 oc_ 开头的飞书群 chatId";
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

export const SECRET_MASK = "******";

function maskSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return secret.length <= 10 ? SECRET_MASK : `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

/** 面向前端展示的配置视图（各类 Secret 只回掩码） */
export function teamMemoryConfigView(cfg: TeamMemoryJobConfig): TeamMemoryJobConfig & {
  timemApiKeyMasked?: string;
  feishuAppSecretMasked?: string;
  litellmKeyMasked?: string;
} {
  return {
    ...cfg,
    ...(cfg.timemApiKey ? { timemApiKey: SECRET_MASK, timemApiKeyMasked: maskSecret(cfg.timemApiKey) } : {}),
    ...(cfg.feishuAppSecret ? { feishuAppSecret: SECRET_MASK, feishuAppSecretMasked: maskSecret(cfg.feishuAppSecret) } : {}),
    ...(cfg.litellmKey ? { litellmKey: SECRET_MASK, litellmKeyMasked: maskSecret(cfg.litellmKey) } : {}),
  };
}

export function saveTeamMemoryConfig(input: Partial<TeamMemoryJobConfig>): TeamMemoryJobConfig {
  const problem = validateTeamMemoryConfig(input);
  if (problem) throw new Error(problem);
  const doc = loadTeamMemoryConfig();
  const next: TeamMemoryJobConfig = { ...doc };
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.dailyReportTime !== undefined && HHMM.test(input.dailyReportTime)) next.dailyReportTime = input.dailyReportTime;
  if (input.morningReportTime !== undefined && HHMM.test(input.morningReportTime)) next.morningReportTime = input.morningReportTime;
  for (const k of ["timemBaseUrl", "feishuAppId", "reportChatId", "reportChatName", "litellmUrl", "summaryModel"] as const) {
    if (input[k] !== undefined) next[k] = (input[k] as string).trim() || undefined;
  }
  // 掩码值 = 不修改已保存的 Secret
  for (const k of ["timemApiKey", "feishuAppSecret", "litellmKey"] as const) {
    if (input[k] !== undefined && input[k] !== SECRET_MASK) next[k] = (input[k] as string).trim() || undefined;
  }
  if (input.env !== undefined) next.env = { ...input.env };
  persistConfig(next);
  return next;
}

/** run 时把配置翻译为子进程 env（子进程 loadEnvFiles 不覆盖已有键 → 页面配置优先于 .env） */
function jobEnv(cfg: TeamMemoryJobConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.timemApiKey) env.TIMEM_API_KEY = cfg.timemApiKey;
  if (cfg.timemBaseUrl) env.TIMEM_BASE_URL = cfg.timemBaseUrl;
  if (cfg.feishuAppId) env.FEISHU_APP_ID = cfg.feishuAppId;
  if (cfg.feishuAppSecret) env.FEISHU_APP_SECRET = cfg.feishuAppSecret;
  if (cfg.reportChatId) env.FEISHU_REPORT_CHAT_ID = cfg.reportChatId;
  if (cfg.litellmUrl) env.LITELLM_URL = cfg.litellmUrl;
  if (cfg.litellmKey) env.LITELLM_KEY = cfg.litellmKey;
  if (cfg.summaryModel) env.REPORT_SUMMARY_MODEL = cfg.summaryModel;
  return { ...env, ...cfg.env };
}

// ── 运行历史 ────────────────────────────────────────────────────

export interface TeamMemoryRun {
  kind: TeamMemoryJobKind;
  /** ISO 时间 */
  startedAt: string;
  finishedAt?: string;
  /** ok | failed | timeout | running */
  status: "ok" | "failed" | "timeout" | "running";
  exitCode?: number;
  /** 手动触发 = manual，调度触发 = schedule */
  trigger: "manual" | "schedule";
  /** 失败/超时原因（一行） */
  error?: string;
  /** stdout 尾部（供历史列表预览） */
  outputTail?: string;
}

const MAX_RUNS = 50;

export function loadTeamMemoryRuns(): TeamMemoryRun[] {
  if (!existsSync(RUNS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(RUNS_FILE, "utf-8")) as TeamMemoryRun[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistRuns(runs: TeamMemoryRun[]): void {
  mkdirSync(dirname(RUNS_FILE), { recursive: true });
  writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2) + "\n", "utf-8");
}

function appendRun(run: TeamMemoryRun): void {
  const runs = loadTeamMemoryRuns();
  runs.unshift(run);
  persistRuns(runs);
}

function updateRun(startedAt: string, patch: Partial<TeamMemoryRun>): void {
  const runs = loadTeamMemoryRuns();
  const idx = runs.findIndex((r) => r.startedAt === startedAt);
  if (idx >= 0) {
    runs[idx] = { ...runs[idx], ...patch };
    persistRuns(runs);
  }
}

// ── 执行（spawn CLI 子进程）────────────────────────────────────

function pnpmBin(): string {
  const candidates = [
    process.env.PNPM_HOME ? resolve(process.env.PNPM_HOME, "pnpm") : "",
    process.env.PNPM_HOME ? resolve(process.env.PNPM_HOME, "pnpm.cmd") : "",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "pnpm";
}

function tailText(file: string, maxChars = 4000): string {
  if (!existsSync(file)) return "";
  try {
    const content = readFileSync(file, "utf-8");
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return "";
  }
}

export interface RunNowResult {
  ok: boolean;
  status: TeamMemoryRun["status"];
  message: string;
  exitCode?: number;
  stdoutTail: string;
  stderrTail: string;
}

/** 立即执行一次日报/晨报（--send 推群）；同步等待完成（超时 5 分钟） */
export async function runTeamMemoryJob(kind: TeamMemoryJobKind, timeoutMs = 300_000): Promise<RunNowResult> {
  const cfg = loadTeamMemoryConfig();
  const startedAt = new Date().toISOString();
  const run: TeamMemoryRun = { kind, startedAt, status: "running", trigger: "manual" };
  appendRun(run);

  const out = openSync(STDOUT_LOG, "a");
  const err = openSync(STDERR_LOG, "a");
  const args = ["--filter", "team-memory-console", "cli", kind, "--send"];

  const result = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>((resolvePromise) => {
    let proc: ChildProcess;
    try {
      proc = spawn(pnpmBin(), args, {
        cwd: REPO_ROOT,
        stdio: ["ignore", out, err],
        env: { ...process.env, ...jobEnv(cfg) },
        detached: false,
      });
    } catch (e) {
      closeSync(out);
      closeSync(err);
      resolvePromise({ code: null, timedOut: false, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolvePromise({ code: null, timedOut: true });
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut: false });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut: false, error: String(e) });
    });
  });

  closeSync(out);
  closeSync(err);

  const finishedAt = new Date().toISOString();
  const stdoutTail = tailText(STDOUT_LOG);
  const stderrTail = tailText(STDERR_LOG, 2000);

  let status: TeamMemoryRun["status"];
  let message: string;
  if (result.timedOut) {
    status = "timeout";
    message = `执行超时（>${Math.round(timeoutMs / 1000)}s），已强制终止；请检查 LLM 网关 / TiMEM 云连通性`;
  } else if (result.error) {
    status = "failed";
    message = `启动失败：${result.error}`;
  } else if (result.code === 0) {
    status = "ok";
    message = `${kind === "report" ? "日报" : "晨报"}生成并推送完成`;
  } else {
    status = "failed";
    message = `执行失败（exit ${result.code}），请查看 stderr 日志`;
  }
  updateRun(startedAt, { finishedAt, status, exitCode: result.code ?? undefined, error: status === "ok" ? undefined : message, outputTail: stdoutTail.slice(-800) });

  return { ok: status === "ok", status, message, exitCode: result.code ?? undefined, stdoutTail, stderrTail };
}

// ── 调度（进程内定时器）────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
/** 每类任务当天是否已触发（key = `${kind}:${YYYY-MM-DD}`），防重复 */
const firedToday = new Set<string>();
let lastTickAt: string | null = null;

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localHHMM(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 下次触发时刻的 ISO 串（供页面倒计时展示）；未启用返回 null */
export function nextRunInfo(): { kind: TeamMemoryJobKind; at: string } | null {
  const cfg = loadTeamMemoryConfig();
  if (!cfg.enabled) return null;
  const now = new Date();
  for (const [kind, hhmm] of [["morning", cfg.morningReportTime], ["report", cfg.dailyReportTime]] as const) {
    const [h, m] = hhmm.split(":").map(Number);
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (t > now && !firedToday.has(`${kind}:${localDateStr()}`)) return { kind, at: t.toISOString() };
  }
  // 今天都过了/已触发 → 明天的晨报
  const [h, m] = cfg.morningReportTime.split(":").map(Number);
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
  return { kind: "morning", at: t.toISOString() };
}

const TICK_MS = 30_000;

function tick(): void {
  lastTickAt = new Date().toISOString();
  const cfg = loadTeamMemoryConfig();
  if (!cfg.enabled) return;
  const today = localDateStr();
  const now = localHHMM();
  for (const [kind, hhmm] of [["report", cfg.dailyReportTime], ["morning", cfg.morningReportTime]] as const) {
    const key = `${kind}:${today}`;
    if (firedToday.has(key)) continue;
    if (now < hhmm) continue;
    firedToday.add(key);
    // 异步执行，不阻塞 tick；早于 hhmm 一小时内才补跑（防进程停摆一整天后乱触发）
    const [h, m] = hhmm.split(":").map(Number);
    const scheduled = new Date();
    scheduled.setHours(h, m, 0, 0);
    if (Date.now() - scheduled.getTime() > 60 * 60_000) {
      console.log(`[team-memory] 跳过 ${key}（已错过超过 1 小时）`);
      continue;
    }
    console.log(`[team-memory] 定时触发 ${kind}（${hhmm}）`);
    void runTeamMemoryJob(kind).then((r) => {
      console.log(`[team-memory] ${kind} ${r.status}: ${r.message}`);
    });
  }
}

export function startTeamMemoryScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(tick, TICK_MS);
  schedulerTimer.unref?.();
  console.log(`[team-memory] 调度器已启动（tick=${TICK_MS / 1000}s，日报 ${loadTeamMemoryConfig().dailyReportTime} / 晨报 ${loadTeamMemoryConfig().morningReportTime}，默认关闭需在页面开启）`);
}

export function stopTeamMemoryScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ── 状态 / 日志 ─────────────────────────────────────────────────

export interface LogTail {
  file: string;
  lines: string[];
}

function tailFile(file: string, n: number): LogTail {
  if (!existsSync(file)) return { file, lines: [] };
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { file, lines: lines.slice(-n) };
  } catch (e) {
    return { file, lines: [`[读取失败: ${String(e)}]`] };
  }
}

export function teamMemoryLogs(tail = 200): { stdout: LogTail; stderr: LogTail } {
  const n = Math.max(1, Math.min(1000, Math.floor(tail) || 200));
  return { stdout: tailFile(STDOUT_LOG, n), stderr: tailFile(STDERR_LOG, n) };
}

export interface TeamMemoryStatus {
  schedulerRunning: boolean;
  enabled: boolean;
  lastTickAt: string | null;
  nextRun: { kind: TeamMemoryJobKind; at: string } | null;
  runs: TeamMemoryRun[];
  config: TeamMemoryJobConfig;
  logs: { stdout: LogTail; stderr: LogTail };
}

export function teamMemoryStatus(tailLines = 30): TeamMemoryStatus {
  const cfg = loadTeamMemoryConfig();
  return {
    schedulerRunning: schedulerTimer !== null,
    enabled: cfg.enabled,
    lastTickAt,
    nextRun: nextRunInfo(),
    runs: loadTeamMemoryRuns().slice(0, 10),
    config: cfg,
    logs: { stdout: tailFile(STDOUT_LOG, tailLines), stderr: tailFile(STDERR_LOG, tailLines) },
  };
}

// ── 飞书群枚举（凭本模块配置的凭证；与 task-loop 同语义但配置源独立）──

export interface FeishuChatItem {
  chatId: string;
  name: string;
}

function readEnvValue(key: string): string | undefined {
  try {
    const content = readFileSync(resolve(process.env.DOTENV_FILE || resolve(REPO_ROOT, ".env")), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim();
    }
  } catch { /* 无 .env */ }
  return undefined;
}

/** 枚举机器人所在飞书群：显式传入 > 本模块已保存配置 > 仓库 .env */
export async function listTeamMemoryChats(override?: { appId?: string; appSecret?: string }): Promise<{ ok: boolean; chats: FeishuChatItem[]; error?: string }> {
  const cfg = loadTeamMemoryConfig();
  const appId = override?.appId?.trim() || cfg.feishuAppId || readEnvValue("FEISHU_APP_ID");
  const appSecret = override?.appSecret?.trim() || cfg.feishuAppSecret || readEnvValue("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    return { ok: false, chats: [], error: "缺少凭证：请先填写并保存 App ID / App Secret" };
  }
  try {
    const tokenResp = (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }).then((r) => r.json())) as { code?: number; msg?: string; tenant_access_token?: string };
    if (tokenResp.code !== 0 || !tokenResp.tenant_access_token) {
      return { ok: false, chats: [], error: `获取 tenant_access_token 失败（code=${tokenResp.code}）：${tokenResp.msg ?? "未知错误"}` };
    }
    const chatsResp = (await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=50", {
      headers: { Authorization: `Bearer ${tokenResp.tenant_access_token}` },
    }).then((r) => r.json())) as { code?: number; msg?: string; data?: { items?: Array<{ chat_id?: string; name?: string }> } };
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
