/**
 * dshWorkflowRun — 通过官方 dsh CLI 的 headless profile 跑一次 workflow 编排。
 *
 * 与 dshAgentHeadless 同一条 spawn 通道（同一 bin.js、同一 headless profile、
 * 同一用户补丁层），差别只在喂给 agent 的任务文本：让模型以给定参数调用
 * `workflow` 工具（@deepseek-ai/dsh-tool-workflow，dsh-base 基座默认装配），
 * 并把工具的最终返回值（JSON）原样作为最终回复输出。
 *
 * 脚本与参数不经命令行/提示词内联，而是写到 $DSH_HOME/workflow-runs/<run>/
 * 下的三个文件（script.js / meta.json / args.json），任务文本只给绝对路径——
 * 规避 shell 转义与提示词长度上限，也让每次运行留下可审计的脚本存档。
 *
 * 单根约束：编排脚本内不得再起 dshWorkflowRun（headless 一次性进程天然无
 * resume，递归需要显式再 spawn，code review 可拦）。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dshBinJs, ensureHeadlessPatch } from "./headless.js";

export interface DshWorkflowMeta {
  /** 短 kebab-case 工作流名 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 何时适用（可选指引） */
  whenToUse?: string;
  /** 进度阶段声明 */
  phases?: Array<{ title: string; detail?: string }>;
}

export interface DshWorkflowRunOptions {
  /** 编排脚本：plain JavaScript body（无 export const meta；meta 单独传） */
  script: string;
  /** 工作流身份块（tool-worfklow 的 meta 参数） */
  meta: DshWorkflowMeta;
  /** 暴露给脚本的 args 全局（JSON 值；裸列表请包一层字段） */
  args?: unknown;
  /** DSH 家目录（profiles/sessions/脚本存档都在这下面） */
  dshHome: string;
  /** 上游 API 密钥（注入为 DEEPSEEK_API_KEY） */
  apiKey: string;
  /** OpenAI 兼容端点（注入为 DEEPSEEK_BASE_URL） */
  baseURL: string;
  /** 覆盖 headless profile 的默认模型（复用 headless 的用户补丁层） */
  model?: string;
  /** 整体超时（默认 600s——workflow 编排通常远长于单轮 headless） */
  timeoutMs?: number;
  /** 额外注入子进程的环境变量 */
  env?: Record<string, string>;
}

export interface DshWorkflowRunResult {
  ok: boolean;
  /** workflow 工具返回值解析结果；解析失败时为 undefined（raw 输出仍在 output） */
  result?: unknown;
  /** 解析器是否从最终回复里可靠提取到了 JSON 返回值 */
  parsed: boolean;
  /** headless 最终回复原文 */
  output: string;
  error?: string;
  durationMs: number;
}

/** 每次运行落盘的文件集合（含绝对路径，供任务文本引用与测试断言）。 */
export interface WorkflowRunFiles {
  dir: string;
  scriptPath: string;
  metaPath: string;
  argsPath: string;
}

/** 把脚本/参数写成 headless agent 可读取的存档文件，返回绝对路径。 */
export function writeWorkflowRunFiles(
  dshHome: string,
  script: string,
  meta: DshWorkflowMeta,
  args: unknown,
): WorkflowRunFiles {
  const runsDir = path.join(dshHome, "workflow-runs");
  mkdirSync(runsDir, { recursive: true });
  const dir = mkdtempSync(path.join(runsDir, "run-"));
  const scriptPath = path.join(dir, "script.js");
  const metaPath = path.join(dir, "meta.json");
  const argsPath = path.join(dir, "args.json");
  writeFileSync(scriptPath, script, "utf8");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(argsPath, JSON.stringify(args ?? {}, null, 2), "utf8");
  return { dir, scriptPath, metaPath, argsPath };
}

/** 组装喂给 headless agent 的任务文本（导出仅为测试）。 */
export function buildWorkflowTask(files: WorkflowRunFiles): string {
  return [
    "Run a workflow orchestration via the `workflow` tool. Call the `workflow` tool exactly once with these parameters:",
    `- meta: the exact JSON object in the file ${files.metaPath} (read it and pass it verbatim)`,
    `- script: the exact JavaScript text in the file ${files.scriptPath} (read it and pass the FULL text verbatim as the \`script\` parameter; do NOT add an \`export const meta\` statement — meta is passed separately)`,
    `- args: the exact JSON value in the file ${files.argsPath} (pass it verbatim as \`args\`)`,
    "",
    "When the workflow completes, your final reply must be ONLY the tool's final return value (the JSON after \"Return value:\") — pretty-printed JSON, no prose, no code fences, no truncation.",
  ].join("\n");
}

/**
 * 从 headless 最终回复中提取 workflow 工具的 JSON 返回值。
 * 依次尝试：整段即 JSON → ```json 围栏 → 首个 { 到末个 } 的最外层截取。
 */
export function parseWorkflowReturnValue(output: string): {
  parsed: boolean;
  value?: unknown;
} {
  const text = output.trim();
  if (!text) return { parsed: false };
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.unshift(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return { parsed: true, value: JSON.parse(c) };
    } catch {
      // 尝试下一个候选
    }
  }
  return { parsed: false };
}

export async function dshWorkflowRun(
  opts: DshWorkflowRunOptions,
): Promise<DshWorkflowRunResult> {
  const started = Date.now();
  if (opts.model) ensureHeadlessPatch(opts.dshHome, opts.model);
  mkdirSync(opts.dshHome, { recursive: true });
  const files = writeWorkflowRunFiles(opts.dshHome, opts.script, opts.meta, opts.args);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DSH_HOME: opts.dshHome,
    DEEPSEEK_API_KEY: opts.apiKey,
    DEEPSEEK_BASE_URL: opts.baseURL,
    ...(opts.env ?? {}),
  };

  const raw = await new Promise<{ code: number | null; out: string; err: string; spawnError?: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [dshBinJs(), "--profile", "headless", buildWorkflowTask(files)],
        { env, cwd: opts.dshHome, windowsHide: true },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        opts.timeoutMs ?? 600_000,
      );
      child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out, err, spawnError: String(e) });
      });
    },
  );

  const output = raw.out.trim();
  const { parsed, value } = parseWorkflowReturnValue(output);
  const durationMs = Date.now() - started;
  if (raw.spawnError) {
    return { ok: false, parsed, output, error: raw.spawnError, durationMs };
  }
  if (raw.code !== 0) {
    const tail = (raw.err || raw.out).trim().split(/\r?\n/).slice(-6).join("\n");
    return { ok: false, parsed, output, error: tail || `exit ${raw.code}`, durationMs };
  }
  return {
    ok: parsed,
    parsed,
    result: parsed ? value : undefined,
    output,
    error: parsed ? undefined : "无法从最终回复中解析出 workflow 返回值 JSON",
    durationMs,
  };
}
