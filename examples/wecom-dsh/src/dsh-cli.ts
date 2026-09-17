/**
 * DSH CLI 子进程封装 — 企微消息 ↔ 官方 dsh headless agent 会话
 *
 * 原理:
 *   - `dsh --profile headless "任务"` = 官方组合器装配的完整 agent（llm/tools/
 *     session/沙箱/skill 一行不缺），跑一次任务、打印结果、退出
 *   - `dsh --profile headless --resume <sessionId> "任务"` = 在既有会话上续聊
 *     （多轮记忆由官方 session 存储承载）
 *   - 会话落盘于 $DSH_HOME/sessions/<工作区munge>/session-<uuid>，与 Web GUI
 *     共用同一 DSH_HOME 时，GUI 会话历史里能看到企微产生的会话
 *
 * 首条消息后用「sessions 目录里新出现的 session-* 目录」发现会话 id
 * （不依赖工作区路径 munge 规则），后续消息一律 --resume。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DshRunOptions {
  /** dsh CLI 的 bin.js 绝对路径（node 直接跑，避免 .cmd shim 问题） */
  dshBinJs: string;
  /** DSH 家目录（注入 DSH_HOME；sessions/profiles 都在这下面） */
  dshHome: string;
  /** agent 工作目录（决定会话归属的工作区 key） */
  cwd: string;
  /** 用户消息文本 */
  task: string;
  /** 续聊的会话 id（缺省 = 新会话） */
  resumeSessionId?: string;
  /** 注入子进程的环境变量（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DSH_PERMISSION_MODE 等） */
  extraEnv?: Record<string, string>;
  /** 整体超时（默认 300s：agent 干活可能较久） */
  timeoutMs?: number;
}

export interface DshRunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** 运行一次 dsh headless（新会话或 --resume 续聊） */
export function dshRun(opts: DshRunOptions): Promise<DshRunResult> {
  const started = Date.now();
  const args = ["--profile", "headless"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  args.push(opts.task);

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [opts.dshBinJs, ...args],
      {
        cwd: opts.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          DSH_HOME: opts.dshHome,
          ...(opts.extraEnv ?? {}),
        } as NodeJS.ProcessEnv,
      },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (code === 0) {
        resolve({ ok: true, output: out.trim(), durationMs });
      } else {
        const tail = (err || out).trim().split(/\r?\n/).slice(-6).join("\n");
        resolve({ ok: false, output: out.trim(), error: tail || `exit ${code}`, durationMs });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: String(e), durationMs: Date.now() - started });
    });
  });
}

/** 列出 $DSH_HOME/sessions 下全部 session-* 目录（带创建时间） */
export function listSessions(dshHome: string): Array<{ dir: string; id: string; mtimeMs: number }> {
  const root = path.join(dshHome, "sessions");
  if (!existsSync(root)) return [];
  const result: Array<{ dir: string; id: string; mtimeMs: number }> = [];
  for (const wsKey of readdirSync(root)) {
    const wsDir = path.join(root, wsKey);
    for (const name of readdirSync(wsDir)) {
      if (!name.startsWith("session-")) continue;
      const dir = path.join(wsDir, name);
      try {
        result.push({ dir, id: name.slice("session-".length), mtimeMs: statMtimeMs(dir) });
      } catch { /* 目录刚被清理等竞态，跳过 */ }
    }
  }
  return result;
}

function statMtimeMs(p: string): number {
  return statSync(p).mtimeMs;
}

/** 持久化 chatid → sessionId 映射（JSON 文件） */
export class SessionStore {
  private map = new Map<string, string>();
  constructor(private readonly filePath: string) {
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
      }
    } catch (e) {
      console.warn("[session-store] 读取失败, 从空映射开始:", e);
    }
  }
  get(chatId: string): string | undefined { return this.map.get(chatId); }
  set(chatId: string, sessionId: string): void {
    this.map.set(chatId, sessionId);
    this.flush();
  }
  delete(chatId: string): void {
    this.map.delete(chatId);
    this.flush();
  }
  private flush(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8");
  }
}
