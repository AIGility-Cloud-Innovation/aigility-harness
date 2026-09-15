/**
 * dshAgentHeadless — 通过官方 dsh CLI 的 headless profile 跑一次真实 agent。
 *
 * 为什么走 headless 子进程而不是进程内组装：headless profile 由官方组合器
 * 装配完整服务图（llm/agent/tools/session/沙箱/skill…），一行不缺；进程内
 * 手工复刻该图属于 M2 的 profile 组合器（见 docs/dsh-生态共建规划.md）。
 * 在那之前，这是「应用消费 dsh agent 能力（含 Skill 工具）」的可靠通道。
 *
 * LLM 上游：deepseek adapter 是 OpenAI 兼容协议，经 DEEPSEEK_BASE_URL /
 * DEEPSEEK_API_KEY 环境变量把端点和密钥指到任意兼容网关（如 bigmodel），
 * 模型名经 headless profile 的用户补丁层（扁平 {id, config} 部分覆盖）改写。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const localRequire = createRequire(import.meta.url);

export interface DshHeadlessOptions {
  /** 任务文本（一次性的用户请求） */
  task: string;
  /** DSH 家目录（profiles/sessions/凭据缓存都在这下面） */
  dshHome: string;
  /** 上游 API 密钥（注入为 DEEPSEEK_API_KEY） */
  apiKey: string;
  /** OpenAI 兼容端点（注入为 DEEPSEEK_BASE_URL，/chat/completions 自动追加） */
  baseURL: string;
  /** 覆盖 headless profile 的默认模型（写入用户补丁层，幂等） */
  model?: string;
  /** 整体超时（默认 180s） */
  timeoutMs?: number;
  /** 额外注入子进程的环境变量（如 DSH_PERMISSION_MODE=read-only） */
  env?: Record<string, string>;
}

export interface DshHeadlessResult {
  ok: boolean;
  /** agent 的最终回复文本（stdout 尾段） */
  output: string;
  error?: string;
  durationMs: number;
}

/** 官方 CLI 的 bin.js 绝对路径（直接用 node 跑，跨平台无 .cmd shim 问题） */
function dshBinJs(): string {
  const pkgPath = localRequire.resolve("@deepseek-ai/dsh/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  const rel = pkg.bin?.dsh;
  if (!rel) throw new Error("@deepseek-ai/dsh 未声明 bin.dsh");
  return path.join(path.dirname(pkgPath), rel);
}

/** 幂等写入 headless profile 的用户补丁层（模型覆盖） */
function ensureHeadlessPatch(dshHome: string, model: string): void {
  const profileDir = path.join(dshHome, "profiles", "headless");
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  mkdirSync(profileDir, { recursive: true });
  const want = [
    `# managed by @aigility-harness/dsh-interop (扁平 {id, config} 部分覆盖)`,
    `- id: agent-default-model`,
    `  config:`,
    `    provider: deepseek-official`,
    `    model: ${model}`,
    ``,
  ].join("\n");
  if (!existsSync(patchPath) || readFileSync(patchPath, "utf8") !== want) {
    writeFileSync(patchPath, want, "utf8");
  }
}

export async function dshAgentHeadless(
  opts: DshHeadlessOptions,
): Promise<DshHeadlessResult> {
  const started = Date.now();
  const binJs = dshBinJs();
  if (opts.model) ensureHeadlessPatch(opts.dshHome, opts.model);
  mkdirSync(opts.dshHome, { recursive: true });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    DSH_HOME: opts.dshHome,
    DEEPSEEK_API_KEY: opts.apiKey,
    DEEPSEEK_BASE_URL: opts.baseURL,
    ...(opts.env ?? {}),
  };

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [binJs, "--profile", "headless", opts.task],
      { env, cwd: opts.dshHome, windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);
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
