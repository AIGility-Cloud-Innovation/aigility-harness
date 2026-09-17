/**
 * DSH CLI 子进程封装 — 企微消息 ↔ 官方 dsh headless agent 会话
 *
 * 原理:
 *   - `dsh --profile headless "任务"` = 官方组合器装配的完整 agent（llm/tools/
 *     session/沙箱/skill 一行不缺），跑一次任务、打印结果、退出
 *   - 会话落盘于 $DSH_HOME/sessions/<工作区munge>/session-<uuid>，与 Web GUI
 *     共用同一 DSH_HOME 时，GUI 会话历史里能看到企微产生的会话
 *
 * 多轮对话: dsh-headless 每次调用都新建会话（session-<uuid>），官方 CLI 无
 * --resume（那是 tui/web 应用的旗标）；多轮记忆由 index.ts 的 TranscriptStore
 * 以滚动上下文注入实现。
 */
import { spawn } from "node:child_process";

export interface DshRunOptions {
  /** dsh CLI 的 bin.js 绝对路径（node 直接跑，避免 .cmd shim 问题） */
  dshBinJs: string;
  /** DSH 家目录（注入 DSH_HOME；sessions/profiles 都在这下面） */
  dshHome: string;
  /** agent 工作目录（决定会话归属的工作区 key） */
  cwd: string;
  /** 用户消息文本（多轮上下文由调用方拼进此文本，见 index.ts TranscriptStore） */
  task: string;
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

/**
 * 运行一次 dsh headless。
 * 注意: dsh-headless 每次调用都新建会话（session-<uuid>），官方 CLI 无 --resume
 * （--resume 是 tui/web 应用的旗标）；多轮对话由 index.ts 的 TranscriptStore 以
 * 上下文注入实现。
 */
export function dshRun(opts: DshRunOptions): Promise<DshRunResult> {
  const started = Date.now();
  const args = ["--profile", "headless", opts.task];

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
