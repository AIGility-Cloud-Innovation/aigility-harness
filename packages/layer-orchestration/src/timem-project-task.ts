/**
 * L4 编排层: timem-task — TiMEM Project 任务判定 → 归仓 → 派发 三段式工作流
 *
 * 替代「任何消息直接建任务 + 固定 standalone」的旧链路, 编排层独占判定：
 *   - ① classify   是否任务（闲聊词/任务意图词规则优先, 判不了调 llm-inference）
 *   - ② identify   归哪个仓库（显式 project_id → agentd identify-project → 反问）
 *   - git 校验      归仓后的 root 必须是有效 git 仓库且配好 origin 远程
 *   - ③ dispatch   create-from-message → (confirm-project) → run → 轮询
 *
 * 设计见 docs/task-orchestration-workflow-design.md。
 * ingress/人格层不做业务判定, 本插件是唯一的任务判定点。
 */
import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
  err,
  llmInferenceRef,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  HealthStatus,
  LlmInferenceRequest,
  LlmInferenceResponse,
} from "@aigility-harness/core";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { RequirementStore } from "./requirement-store.js";
import type { Consolidation, Requirement } from "./requirement-store.js";
import {
  CONSOLIDATION_SYSTEM_PROMPT,
  parseConsolidation,
  buildConsolidation,
  renderConsolidation,
} from "./consolidation.js";

// ---- 请求/响应 ----

export interface TimemProjectTaskRequest {
  /** 用户任务指令(飞书消息文本等) */
  user_input: string;
  /** 用户 ID(记忆隔离/creator 记录) */
  user_id?: string;
  /** 会话 ID */
  session_id?: string;
  /** 来源标识(默认 feishu) */
  source?: string;
  /** 任务标题(默认取 user_input) */
  title?: string;
  /** 项目 ID: 显式指定时跳过归仓直接使用 */
  project_id?: string;
  /** 会话 ID(identify-project 绑定查询用, 与 session_id 同源) */
  conversation_id?: string;
  /** 消息 ID(幂等键: create-from-message 的 sourceMessageId) */
  message_id?: string;
  /** 聊天类型: p2p | group */
  chat_type?: string;
  /** 资源引用(图片等, 目前透传不消费) */
  resources?: Array<Record<string, unknown>>;
  /** 显示确认：确认指定任务(待提示词确认)后执行 */
  confirm_task_id?: string;
  /** 确认时覆盖提示词(可空=用原提示词) */
  prompt_override?: string;
  /** 立即执行(跳过等待延迟，1 秒后自动运行) */
  run_now?: boolean;
  /** 显式信号(前端按钮): summarize=汇总执行, confirm=确认汇总单, chat=普通消息 */
  signal?: "chat" | "summarize" | "confirm";
  /** 静默自动汇总窗口 ms(0=关闭; 默认 env TIMEM_QUIET_SUMMARIZE_MS 或 10 分钟) */
  quiet_ms?: number;
}

export type TimemProjectTaskResponse =
  | { type: "chat"; text: string }
  | { type: "ask"; text: string }
  | { type: "task"; taskId: string; status: string; response: string }
  | { type: "confirm"; taskId: string; status: string; promptPreview: string; response: string }
  | { type: "summary"; text: string }
  /** 聊天期: 已记下第 N 条需求(前端据此渲染实时清单) */
  | { type: "collected"; requirementId: string; content: string; count: number; text: string }
  /** 收敛期: 汇总单(确认页), conflicts/missing 为高亮项 */
  | {
      type: "consolidation";
      consolidationId: string;
      version: number;
      summaryText: string;
      conflicts: string[];
      missing: string[];
    }
  | { type: "error"; text: string };

// ---- ① classify: 任务判定 ----

const CHAT_ONLY =
  /^(你好|hi|hello|哈喽|在吗|谢谢|辛苦了|辛苦|好的|收到|嗯|哦|在|再见|拜拜|嗨|hey)$/i;

const TASK_VERBS =
  /(执行|修复|修改|改|创建|新建|开发|实现|跑|运行|测试|部署|排查|更新|删|清理|检查|验证|生成|写|分析|重构)/;

const PROJECT_PATTERN = /在\s*([\w\-\.\/]+)\s*(?=(项目|仓库|repo))/;

export type ClassifyResult =
  | { type: "chat"; text: string }
  | { type: "task"; project: string | null }
  | { type: "unknown" };

export function classifyMessage(input: string): ClassifyResult {
  const text = input.trim();
  if (CHAT_ONLY.test(text)) {
    return {
      type: "chat",
      text: "我在的，有什么任务需要我执行吗？",
    };
  }
  const hasTaskVerb = TASK_VERBS.test(text);
  if (hasTaskVerb) {
    const m = PROJECT_PATTERN.exec(text);
    return { type: "task", project: m ? m[1] : null };
  }
  return { type: "unknown" };
}

function parseLlmClassification(raw: string): {
  is_task?: boolean;
  project?: string | null;
  reason?: string;
} {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as {
      is_task?: boolean;
      project?: string | null;
      reason?: string;
    };
  } catch {
    return {};
  }
}

const CLASSIFY_SYSTEM_PROMPT = `你是任务判定器。判断用户消息是否是「要 AI 执行的任务」（如写代码、改 bug、跑测试、部署等）。
如果是任务，提取其针对的项目/仓库名（如有）。
只输出 JSON，不要输出任何其他内容：
{"is_task": bool, "project": string|null, "reason": string}`;

async function classifyWithLlm(
  ctx: SeamContext,
  input: string,
): Promise<ClassifyResult> {
  try {
    const req: LlmInferenceRequest = {
      model: process.env.LLM_MODEL ?? "glm-4.6",
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0,
    };
    console.log(`[timem-project-task] classifyWithLlm start: model=${process.env.LLM_MODEL ?? "glm-4.6"} input="${input.slice(0, 40)}"`);
    const t0 = Date.now();
    const res = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
      llmInferenceRef,
      req,
    )) as Result<LlmInferenceResponse>;
    console.log(`[timem-project-task] classifyWithLlm done: ${Date.now() - t0}ms ok=${res.ok}`);
    if (!res.ok) return { type: "unknown" };
    const parsed = parseLlmClassification(res.value.text);
    // 非任务或 JSON 解析失败 → 降级按非任务处理(unknown → chat)
    if (parsed.is_task !== true) return { type: "unknown" };
    return { type: "task", project: parsed.project ?? null };
  } catch {
    return { type: "unknown" };
  }
}

// ---- UDS 配置 ----

/** agentd socket 默认路径(与 timem-project cmd/timem-agentd 一致) */
export function defaultSocketPath(): string {
  const fromEnv = process.env["TIMEM_AGENTD_SOCK"];
  if (fromEnv) return fromEnv;
  const configHome = process.env["XDG_CONFIG_HOME"] ?? `${process.env["HOME"] ?? ""}/.config`;
  return `${configHome}/TiMEM Project/agentd.sock`;
}

/** agentd bearer token(agentd 启动时生成, harness 侧由部署方注入 env) */
export function defaultToken(): string {
  return process.env["TIMEM_AGENTD_TOKEN"] ?? "";
}

// ---- UDS HTTP client (node http.request 支持 socketPath) ----

interface UdsResponse {
  status: number;
  body: string;
}

function udsRequest(
  socketPath: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          console.log(`[timem-project-task] UDS ${method} ${path} → HTTP ${res.statusCode} body=${data.slice(0, 200)}`);
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`agentd request timeout (${timeoutMs}ms)`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 解析 agentd application.Response/纯 JSON, 失败抛错 */
function parseUdsJson<T>(resp: UdsResponse): T {
  let parsed: any;
  try {
    parsed = JSON.parse(resp.body || "{}");
  } catch {
    throw new Error(`agentd 响应非 JSON: HTTP ${resp.status} ${resp.body.slice(0, 120)}`);
  }
  if (resp.status >= 400) {
    const msg = parsed?.message ?? parsed?.error ?? `HTTP ${resp.status}`;
    throw new Error(String(msg));
  }
  return parsed as T;
}

// ---- ② identify: 归仓 ----

interface IdentifyProjectResponse {
  projectId?: string;
  confidence?: number;
  method?: string;
  reason?: string;
  rootPaths?: string[];
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof error === "object" && "code" in error
          ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function gitInWorkTree(root: string): Promise<boolean> {
  const r = await runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], root, 5_000);
  return r.code === 0 && r.stdout.trim() === "true";
}

async function gitHasOrigin(root: string): Promise<boolean> {
  const r = await runCommand("git", ["-C", root, "remote", "get-url", "origin"], root, 5_000);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// ---- 需求缓冲区 (E2 扩展: COLLECTING → SUMMARIZING → CONFIRMING → EXECUTING) ----

/** 缓冲模式默认关闭时走快车道的多需求连接词 */
const MULTI_REQ_CONNECTIVES = /还有|另外|同时|以及|顺便|再加上|其次|然后|再帮我|还要/;

/** 「聊完了」显式信号关键词 */
const SUMMARIZE_RE = /^(就这些|就这些了|汇总吧|汇总一下|开始汇总|没别的|没有了|聊完了|沟通结束|需求就这些)/;

/** 汇总单确认关键词(CONFIRMING 阶段) */
const CONSOLIDATION_CONFIRM_RE = /^(确认|确认执行|开始执行|执行吧|就这么办|同意|ok|okay)$/i;

/** 静默自动汇总窗口: env 可覆盖, 默认 10 分钟; request.quiet_ms 优先 */
function defaultQuietMs(): number {
  const env = Number(process.env["TIMEM_QUIET_SUMMARIZE_MS"]);
  return Number.isFinite(env) && env >= 0 ? env : 10 * 60_000;
}

/** 模块级单例存储(JSON 文件持久化, 路径 env 可配) */
let requirementStore: RequirementStore | null = null;
function getStore(): RequirementStore {
  if (!requirementStore) {
    requirementStore = new RequirementStore(process.env["TIMEM_REQUIREMENT_STORE_PATH"] || undefined);
    requirementStore.recover();
  }
  return requirementStore;
}

/** 测试注入用(生产勿动) */
export function resetRequirementStoreForTest(path?: string): void {
  requirementStore = new RequirementStore(path);
}

/** 每会话一个静默计时器(借鉴 timem-project TopicSink 的 quiet window + 防抖) */
const quietTimers = new Map<string, NodeJS.Timeout>();

function armQuietTimer(
  sessionId: string,
  quietMs: number,
  fire: () => void,
): void {
  const prev = quietTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  if (quietMs <= 0) {
    quietTimers.delete(sessionId);
    return;
  }
  const t = setTimeout(() => {
    quietTimers.delete(sessionId);
    fire();
  }, quietMs);
  (t as unknown as { unref?: () => void }).unref?.();
  quietTimers.set(sessionId, t);
}

function sessionIdOf(request: TimemProjectTaskRequest, ctx: SeamContext): string {
  return request.conversation_id ?? request.session_id ?? ctx.sessionId;
}

/** 聊天期追加一条需求, 返回 collected 响应 */
function appendRequirement(
  sessionId: string,
  request: TimemProjectTaskRequest,
  ctx: SeamContext,
): TimemProjectTaskResponse {
  const store = getStore();
  const content = request.user_input.trim().slice(0, 200);
  const req = store.append(sessionId, content, request.user_input);
  const count = store.listOpen(sessionId).length;
  // 确认期补充需求 → 回到收集(E2: CONFIRMING → SUMMARIZING), 重汇总由下一条消息触发
  if (store.session(sessionId).phase === "confirming") {
    store.setPhase(sessionId, "summarizing");
  }
  // 静默自动汇总: provider 无反向推送通道 → 定时器只预计算汇总单, 下一条消息送达
  armQuietTimer(sessionId, request.quiet_ms ?? defaultQuietMs(), () => {
    void consolidateFor(ctx, sessionId).catch(() => undefined);
  });
  return {
    type: "collected",
    requirementId: req.id,
    content,
    count,
    text: `已记录第 ${count} 条需求 📝「${content.slice(0, 40)}」\n继续说，聊完回复「就这些了」我再统一汇总设计。`,
  };
}

/** 收敛期: 一次 LLM 调用(非法输出重试一次), 产出汇总单并落 CONFIRMING */
async function consolidateFor(
  ctx: SeamContext,
  sessionId: string,
): Promise<Result<Consolidation>> {
  const store = getStore();
  const open = store.listOpen(sessionId);
  if (open.length === 0) return err("还没有记录任何需求");
  const userContent = open.map((r: Requirement) => `${r.id}: ${r.content}`).join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(llmInferenceRef, {
      model: process.env.LLM_MODEL ?? "glm-4.6",
      messages: [
        { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
    })) as Result<LlmInferenceResponse>;
    if (!res.ok) continue;
    const parsed = parseConsolidation(res.value.text, open);
    if (parsed) {
      const prev = store.latestConsolidation(sessionId);
      const cons = buildConsolidation(sessionId, parsed.items, parsed.designDoc, (prev?.version ?? 0) + 1);
      store.saveConsolidation(cons);
      store.setPhase(sessionId, "confirming");
      return ok(cons);
    }
  }
  return err("汇总失败：模型输出无法解析（已重试一次）");
}

/** 汇总单 → 确认响应 */
function consolidationResponse(cons: Consolidation): TimemProjectTaskResponse {
  return {
    type: "consolidation",
    consolidationId: cons.id,
    version: cons.version,
    summaryText: renderConsolidation(cons),
    conflicts: cons.items.flatMap((it) => (it.blockedByConflict ? [it.blockedByConflict] : [])),
    missing: cons.items.flatMap((it) => it.missingInformation ?? []),
  };
}

/** 汇总单项是否已执行完(其全部需求已 tasked; 断点续跑用) */
function isItemDone(cons: Consolidation, itemIndex: number): boolean {
  const store = getStore();
  const item = cons.items[itemIndex];
  if (!item) return true;
  return item.requirementIds.every((id) => store.get(id)?.status === "tasked");
}

/** 执行期: 按拓扑序逐项 dispatch, 失败即暂停(E5 规则 1) */
async function executeConsolidationQueue(
  socketPath: string,
  token: string,
  source: string,
  request: TimemProjectTaskRequest,
  sessionId: string,
): Promise<TimemProjectTaskResponse> {
  const store = getStore();
  const cons = store.latestConsolidation(sessionId);
  if (!cons) return { type: "error", text: "没有可执行的汇总单" };
  store.setPhase(sessionId, "executing");
  const results: string[] = [];
  let paused = false;

  for (const idx of cons.executionOrder) {
    const item = cons.items[idx];
    if (!item) continue;
    if (isItemDone(cons, idx)) continue; // 断点续跑: 跳过已完成项
    if (item.blockedByConflict) {
      results.push(`⏸「${item.taskTitle}」冲突待拍板（${item.blockedByConflict}），已跳过`);
      continue;
    }
    // 归仓 + git 校验(复用单任务链路)
    const identified = await activeHooks.udsRequest(socketPath, token, "POST", "/v1/tasks/identify-project", {
      text: item.taskDescription,
      conversationId: sessionId,
      senderId: request.user_id ?? "",
    });
    const ident = parseUdsJson<IdentifyProjectResponse>(identified);
    const projectId = ident.projectId;
    if (!projectId) {
      results.push(`⏸「${item.taskTitle}」识别不到归属项目，队列暂停。处理后回复「确认」继续。`);
      paused = true;
      break;
    }
    const root = Array.isArray(ident.rootPaths) ? ident.rootPaths[0] : undefined;
    const gitError = await validateProjectGit(projectId, root);
    if (gitError) {
      results.push(`⏸「${item.taskTitle}」${gitError}`);
      paused = true;
      break;
    }
    // 派发: 每个任务共享统一设计文档 + 验收标准(E5 规则 2)
    const taskReq: TimemProjectTaskRequest = {
      ...request,
      user_input: `【统一设计】\n${cons.designDoc}\n\n【任务】\n${item.taskDescription}\n\n【验收标准】\n${item.acceptanceCriteria.join("；")}`,
      title: item.taskTitle,
      message_id: `${cons.id}-${idx}`,
    };
    const created = await dispatch(socketPath, token, source, taskReq, projectId);
    const taskId = created?.id ?? created?.taskId ?? "";
    if (!taskId) {
      results.push(`⏸「${item.taskTitle}」创建任务失败（${created?.lastError ?? "未知错误"}），队列暂停。`);
      paused = true;
      break;
    }
    // E5 规则 0: 确认只发生一次(汇总单已人审), 执行循环对 agentd 程序自动确认并立即运行
    await confirmTask(socketPath, token, taskId, undefined, true);
    const status = await pollTaskUntilFinal(socketPath, token, taskId);
    if (status === "completed" || status === "needs_review") {
      results.push(`${status === "completed" ? "✅" : "👀"}「${item.taskTitle}」${status === "completed" ? "完成" : "执行完毕待验收"}`);
      for (const rid of item.requirementIds) {
        // 一期简化: 确认执行后统一 tasked(merged/dropped 细化留二期)
        store.transition(rid, "open", "tasked");
      }
    } else {
      results.push(`❌「${item.taskTitle}」${status === null ? "超时" : `状态 ${status}`}，后续任务暂停。处理完回复「确认」续跑。`);
      paused = true;
      break;
    }
  }

  if (!paused) {
    store.setPhase(sessionId, "collecting"); // E2: 全部完成回到聊天
    results.push("全部任务处理完毕 🎉 有新需求随时说。");
  }
  return { type: "task", taskId: cons.id, status: paused ? "paused" : "completed", response: results.join("\n") };
}

// ---- Provider 实现 ----

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 分钟轮询上界

let activeSocketPath = defaultSocketPath();
let activeToken = defaultToken();

/** 运行时覆盖配置(装配时可注入) */
export function enableTimemProjectTask(options: { socketPath?: string; token?: string }): void {
  if (options.socketPath) activeSocketPath = options.socketPath;
  if (options.token !== undefined) activeToken = options.token;
}

interface AgentdTask {
  id?: string;
  status?: string;
  projectId?: string;
  title?: string;
  description?: string;
  lastError?: string;
}

interface AgentdContextGate {
  name?: string;
  value?: string;
}

export const timemProjectTaskProvider: Provider<TimemProjectTaskRequest, TimemProjectTaskResponse> = {
  service: {
    id: "@orchestration/timem-project-task",
    version: "1.0.0",
    layer: LayerId.Orchestration,
    description:
      "TiMEM Project 三段式任务工作流: classify(是否任务) → identify(归仓) → dispatch(派发执行)",
  },
  name: "orchestration-timem-task",
  state: PluginState.Active,
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: `timem-task bridge ready (socket=${activeSocketPath})`,
      checkedAt: new Date().toISOString(),
    };
  },
  async execute(
    request: TimemProjectTaskRequest,
    ctx: SeamContext,
    _options?: { socketPath?: string; token?: string },
  ): Promise<Result<TimemProjectTaskResponse>> {
    const socketPath = _options?.socketPath ?? activeSocketPath;
    const token = _options?.token ?? activeToken;
    const source = request.source ?? "feishu";

    if (!request.user_input?.trim()) {
      return err("任务指令为空");
    }

    try {
      // ⓪ 确认意图：确认待执行任务（提示词确认闸门）
      if (request.confirm_task_id) {
        const confirmed = await confirmTask(socketPath, token, request.confirm_task_id, request.prompt_override, request.run_now);
        if (!confirmed) {
          return ok({ type: "error", text: "确认任务失败：任务不存在或不在待确认状态" });
        }
        const s = confirmed.status ?? "queued";
        return ok({
          type: "task",
          taskId: request.confirm_task_id,
          status: s,
          response:
            s === "queued"
              ? request.run_now
                ? `已确认 ✅ 任务（ID: ${request.confirm_task_id}）将立即执行。`
                : `已确认 ✅ 任务（ID: ${request.confirm_task_id}）将执行。确认后 1 小时自动运行，也可回复「立即执行」马上跑。`
              : summarizeTask(confirmed, s),
        });
      }

      // ⓪ 查进度意图：当前项目群任务进度
      const PROGRESS_RE = /^(查看|看下|看看|查|查询|汇报|报告)?\s*(任务进度|任务状态|进度|状态|进行到哪|跑到哪)/;
      if (PROGRESS_RE.test(request.user_input.trim())) {
        const raw = await fetchTaskSummary(socketPath, token);
        const sum = parseUdsJson<TaskSummary>(raw);
        const lines = [`📊 当前项目群任务进度（共 ${sum.total ?? 0} 个）：`];
        const statusNames: Record<string, string> = {
          pending_confirm: "⏳ 待确认",
          pending_project: "❓ 待归仓",
          queued: "📥 排队中",
          preparing: "🔧 准备中",
          running: "🔄 运行中",
          needs_review: "👀 待验收",
          completed: "✅ 已完成",
          failed: "❌ 失败",
          blocked: "🚫 阻塞",
        };
        const st = sum.byStatus ?? {};
        const statusLine = Object.entries(st)
          .map(([k, v]) => `${statusNames[k] ?? k}: ${v}`)
          .join("，");
        if (statusLine) lines.push(`总览：${statusLine}`);
        const projects = sum.projects ?? {};
        const projEntries = Object.entries(projects)
          .filter(([k]) => k !== "(未归属)")
          .sort((a, b) => (b[1]?.total ?? 0) - (a[1]?.total ?? 0));
        if (projEntries.length > 0) {
          lines.push("");
          lines.push("按项目：");
          for (const [pid, p] of projEntries.slice(0, 8)) {
            const running = p.running ?? 0;
            const pending = p.pendingConfirm ?? 0;
            const failed = p.failed ?? 0;
            const mark = running > 0 ? " 🔄" : pending > 0 ? " ⏳" : failed > 0 ? " ❌" : "";
            lines.push(`- ${pid}：共 ${p.total}（运行 ${running} / 待确认 ${pending} / 失败 ${failed}）${mark}`);
          }
        }
        const recent = sum.recent ?? [];
        if (recent.length > 0) {
          lines.push("");
          lines.push("最近任务：");
          for (const t of recent.slice(0, 5)) {
            const name = statusNames[t.status ?? ""] ?? t.status ?? "unknown";
            lines.push(`- [${name}] ${t.title?.slice(0, 30) ?? "(无标题)"}（${t.projectId ?? "未归属"}）`);
          }
        }
        return ok({ type: "summary", text: lines.join("\n") });
      }

      // ⓪b 取消意图：取消本会话的可取消任务（待确认/排队/运行中）
      // 「取消该任务」→ 最近一个；「取消该任务:xxx」→ 按 xxx 匹配标题/描述
      const CANCEL_RE = /^(取消|撤销|别执行|不做了|不要了|停下|停止|作废)\s*(该任务|这个任务|这任务|任务)?\s*[:：]?\s*(.*)/;
      const cancelMatch = request.user_input.trim().match(CANCEL_RE);
      if (cancelMatch) {
        const keyword = (cancelMatch[2] ?? "").trim();
        const listRaw = await activeHooks.udsRequest(socketPath, token, "GET", "/v1/tasks");
        const tasks = parseUdsJson<Array<{ id?: string; title?: string; description?: string; status?: string; sourceConversationId?: string; createdAt?: string }>>(listRaw);
        const mine = (Array.isArray(tasks) ? tasks : [])
          .filter((t) => (t.sourceConversationId ?? "") === (request.conversation_id ?? request.session_id ?? ""))
          .filter((t) => ["pending_confirm", "pending_project", "queued", "running"].includes(t.status ?? ""))
          .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
        let cancelable = mine;
        if (keyword) {
          cancelable = mine.filter(
            (t) => (t.title ?? "").includes(keyword) || (t.description ?? "").includes(keyword),
          );
        }
        console.log(`[timem-project-task] cancel: keyword="${keyword}" mine=${mine.length} cancelable=${cancelable.length} conv=${request.conversation_id ?? request.session_id ?? ""}`);
        if (cancelable.length === 0) {
          const hint = keyword ? `（未找到描述包含「${keyword}」的可取消任务）` : "";
          return ok({ type: "chat", text: `当前没有可取消的任务${hint}。` });
        }
        const target = cancelable[0];
        await activeHooks.udsRequest(socketPath, token, "DELETE", `/v1/tasks/${target.id}`);
        return ok({
          type: "task",
          taskId: target.id ?? "",
          status: "cancelled",
          response:
            keyword && cancelable.length === 1
              ? `已取消任务 ✅「${target.title?.slice(0, 40) ?? "(无标题)"}」`
              : `已取消任务 ✅「${target.title?.slice(0, 40) ?? "(无标题)"}」（匹配 ${cancelable.length} 个，取消了最近 1 个）`,
        });
      }

      // ⓪c 需求缓冲区分流 (E2 扩展: 聊天累积 → 汇总 → 确认 → 按序执行)
      const sessionId = sessionIdOf(request, ctx);
      const store = getStore();
      const input = request.user_input.trim();

      // 「聊完了」显式信号(关键词或前端按钮) → 汇总收敛
      if (request.signal === "summarize" || SUMMARIZE_RE.test(input)) {
        const cons = await consolidateFor(ctx, sessionId);
        if (!cons.ok) return ok({ type: "error", text: cons.error });
        return ok(consolidationResponse(cons.value));
      }

      // CONFIRMING/EXECUTING 阶段的确认意图 → 按序执行/断点续跑
      // (新需求消息不在此拦截, 交给下方 classify 判定后走追加+重汇总)
      const phase = store.session(sessionId).phase;
      if (
        (phase === "confirming" || phase === "executing") &&
        (request.signal === "confirm" || CONSOLIDATION_CONFIRM_RE.test(input))
      ) {
        return ok(await executeConsolidationQueue(socketPath, token, source, request, sessionId));
      }

      // ① classify: 是否任务
      let verdict = classifyMessage(request.user_input);
      if (verdict.type === "unknown") {
        verdict = await classifyWithLlm(ctx, request.user_input);
      }
      if (verdict.type === "chat") {
        return ok({ type: "chat", text: verdict.text });
      }
      if (verdict.type === "unknown") {
        return ok({
          type: "chat",
          text: "我在的，有什么任务需要我执行吗？可以描述为「在 xx 项目修复一个 bug」。",
        });
      }

      // ①a 缓冲分流 (E8): 显式项目名或显式 project_id + 单一动作(无多需求连接词)
      //    → 快车道直走原三段式; 其余任务意图 → 进需求缓冲区, 聊天期绝不执行(E2 原则 1)
      const fastLane =
        (PROJECT_PATTERN.test(request.user_input) || !!request.project_id) &&
        !MULTI_REQ_CONNECTIVES.test(request.user_input);
      if (!fastLane) {
        const collected = appendRequirement(sessionId, request, ctx);
        // 确认页补充需求 → 立即重汇总(v+1), E9-5
        if (phase === "confirming") {
          const reCons = await consolidateFor(ctx, sessionId);
          if (reCons.ok) return ok(consolidationResponse(reCons.value));
        }
        return ok(collected);
      }

      // ①b CONFIRMING 阶段的非任务输入 → 重展汇总单(等确认, 不被闲聊带偏)
      if (phase === "confirming" && store.latestConsolidation(sessionId)) {
        return ok(consolidationResponse(store.latestConsolidation(sessionId)!));
      }

      // ② identify: 归仓(显式 project_id 优先; 仍调 identify-project 以取 rootPaths 供 git 校验)
      console.log(`[timem-project-task] identify start: ${request.user_input.slice(0, 30)}`);
      const identifyBody = {
        text: request.user_input,
        conversationId: request.conversation_id ?? request.session_id ?? ctx.sessionId,
        senderId: request.user_id ?? "",
        ...(request.project_id ? { projectId: request.project_id } : {}),
      };
      console.log(`[timem-project-task] identify body: ${JSON.stringify(identifyBody).slice(0, 300)}`);
      const identified = await activeHooks.udsRequest(
        socketPath,
        token,
        "POST",
        "/v1/tasks/identify-project",
        identifyBody,
      );
      const ident = parseUdsJson<IdentifyProjectResponse>(identified);
      const projectId = request.project_id ?? ident.projectId;
      if (!projectId) {
        return ok({
          type: "ask",
          text: "这个任务要归到哪个项目/仓库？",
        });
      }

      // git 校验: 归仓后、派发前(绝不带坏 git 去派发执行)
      const root = Array.isArray(ident.rootPaths) ? ident.rootPaths[0] : undefined;
      const gitError = await validateProjectGit(projectId, root);
      if (gitError) {
        return ok({ type: "error", text: gitError });
      }

      // ③ dispatch: 派发执行
      const created = await dispatch(
        socketPath,
        token,
        source,
        request,
        projectId,
      );
      if (!created) {
        return ok({ type: "error", text: "agentd 创建任务失败" });
      }
      const taskId = created.id ?? created.taskId ?? "";
      if (!taskId) {
        return ok({
          type: "error",
          text: `agentd 创建任务失败: ${created.lastError ?? "未知错误"}`,
        });
      }

      // 确认闸门：任务是 pending_confirm → 返回确认预览（不执行）
      if ((created.status ?? "") === "pending_confirm") {
        const task: AgentdTask = { id: taskId, status: "pending_confirm", lastError: created.lastError };
        return ok({
          type: "confirm",
          taskId,
          status: "pending_confirm",
          promptPreview: "（执行提示词预览，确认后派 codex 执行）",
          response: `任务已创建 📋（ID: ${taskId}）
\n将派 codex 执行此任务。请确认提示词：\n> ${request.user_input.slice(0, 200)}\n\n回复「确认执行」或「确认」即派发；回复「立即执行」则跳过 1 小时等待立即运行。`,
        });
      }
      if ((created.status ?? "") === "pending_project") {
        return ok({
          type: "ask",
          text: "这个任务我还没识别出要归到哪个项目/仓库，请告诉我项目名。",
        });
      }

      // 汇总终态并返回
      const status = await pollTaskUntilFinal(socketPath, token, taskId);
      if (status === null) {
        return ok({
          type: "task",
          taskId,
          status: "timeout",
          response: summarizeTask(
            { id: taskId, status: "timeout", lastError: created.lastError },
            "timeout",
          ),
        });
      }
      const task: AgentdTask = { id: taskId, status, lastError: created.lastError };
      return ok({
        type: "task",
        taskId,
        status,
        response: summarizeTask(task, status),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[timem-project-task] 处理异常: ${msg} (type=${typeof e}, ctor=${(e as any)?.constructor?.name})`);
      if (
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOENT") ||
        msg.includes("EPERM") ||
        msg.includes("EACCES")
      ) {
        return ok({
          type: "error",
          text: `执行引擎未就绪（agentd 未启动或 socket 不存在: ${socketPath}）。请稍后重试。`,
        });
      }
      return ok({ type: "error", text: `执行失败: ${msg}` });
    }
  },
};

// ---- 可测钩子(生产恒定, 测试可覆写) ----
export interface TimemTaskHooks {
  udsRequest: typeof udsRequest;
  gitInWorkTree: typeof gitInWorkTree;
  gitHasOrigin: typeof gitHasOrigin;
}

const productionHooks: TimemTaskHooks = {
  udsRequest,
  gitInWorkTree,
  gitHasOrigin,
};

let activeHooks: TimemTaskHooks = productionHooks;

export function overrideTimemTaskHooks(hooks: Partial<TimemTaskHooks>): void {
  activeHooks = { ...activeHooks, ...hooks };
}

export function resetTimemTaskHooks(): void {
  activeHooks = productionHooks;
}

// ---- git 校验（归仓后、派发前）----

async function validateProjectGit(
  projectId: string,
  root: string | undefined,
): Promise<string | null> {
  if (!root || !root.trim()) {
    return `项目「${projectId}」未配置本地工作区路径，无法校验 git 仓库。`;
  }
  const isRepo = await activeHooks.gitInWorkTree(root);
  if (!isRepo) {
    const errText = "root 目录不是 git 工作树（git rev-parse 失败或非仓库）";
    return `项目「${projectId}」不是有效的 git 仓库（${errText}），无法执行任务。请先将该目录初始化为 git 仓库。`;
  }
  const hasOrigin = await activeHooks.gitHasOrigin(root);
  if (!hasOrigin) {
    return `项目「${projectId}」未配置 origin 远程，无法执行任务。请先 git remote add origin …`;
  }
  return null;
}

// ---- dispatch: create-from-message → confirm-project → run → poll ----

interface TaskSummary {
  total?: number;
  byStatus?: Record<string, number>;
  projects?: Record<string, ProjectTaskSummary>;
  recent?: Array<{
    id?: string;
    title?: string;
    status?: string;
    projectId?: string;
    updatedAt?: string;
  }>;
}

interface ProjectTaskSummary {
  total?: number;
  running?: number;
  pendingConfirm?: number;
  failed?: number;
  completed?: number;
  byStatus?: Record<string, number>;
}

interface CreateFromMessageResult {
  id?: string;
  taskId?: string;
  status?: string;
  lastError?: string;
  contextGate?: AgentdContextGate | null;
  pending_project?: boolean;
  scheduledRunAtMs?: number | null;
}

async function dispatch(
  socketPath: string,
  token: string,
  source: string,
  request: TimemProjectTaskRequest,
  projectId: string,
): Promise<CreateFromMessageResult | null> {
  const createBody = {
    source,
    sourceMessageId: request.message_id ?? request.session_id ?? "",
    sourceConversationId: request.conversation_id ?? request.session_id ?? "",
    title: request.title ?? request.user_input.slice(0, 80),
    description: request.user_input,
    text: request.user_input,
    projectId,
  };
  console.log(`[timem-project-task] dispatch createBody.sourceMessageId=${createBody.sourceMessageId} message_id=${request.message_id ?? "(undefined)"} session_id=${request.session_id ?? "(undefined)"}`);
  const created = await activeHooks.udsRequest(
    socketPath,
    token,
    "POST",
    "/v1/tasks/create-from-message",
    createBody,
  );
  const task = parseUdsJson<CreateFromMessageResult>(created);
  const taskId = task.id ?? task.taskId ?? "";
  if (!taskId) return null;

  // 确认闸门分两层：
  // 1) 项目归属闸门（pending_project）：项目已被 identify 解析，自动确认归属（任务转 pending_confirm）
  // 2) 提示词确认闸门（pending_confirm）：必须等用户确认提示词后才执行（由 confirmTask 触发）
  // 任何情况下都不自动 run。
  if (task.pending_project || task.status === "pending_project") {
    const confirm = await activeHooks.udsRequest(
      socketPath,
      token,
      "POST",
      `/v1/tasks/${taskId}/confirm-project`,
      { projectId },
    );
    const confirmed = parseUdsJson<CreateFromMessageResult>(confirm);
    return { ...task, status: confirmed.status ?? "pending_confirm" };
  }
  return task;
}

// ---- 确认流程 ----

async function confirmTask(
  socketPath: string,
  token: string,
  taskId: string,
  promptOverride?: string,
  runNow?: boolean,
): Promise<AgentdTask | null> {
  // 若仍未归属项目(低置信)先补项目确认；高置信任务已带 projectId 无此步骤。
  const body: Record<string, unknown> = {};
  if (promptOverride && promptOverride.trim()) body.promptOverride = promptOverride.trim();
  if (runNow) body.delayMs = 1000; // 立即执行：1 秒后自动运行
  const confirm = await activeHooks.udsRequest(
    socketPath,
    token,
    "POST",
    `/v1/tasks/${taskId}/confirm-prompt`,
    body,
  );
  return parseUdsJson<AgentdTask>(confirm);
}

// ---- 进度查询 ----

async function fetchTaskSummary(socketPath: string, token: string): Promise<UdsResponse> {
  const raw = await activeHooks.udsRequest(socketPath, token, "GET", "/v1/tasks/summary");
  return raw;
}

// ---- 轮询 ----

async function pollTaskUntilFinal(
  socketPath: string,
  token: string,
  taskId: string,
): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await activeHooks.udsRequest(socketPath, token, "GET", `/v1/tasks/${taskId}`);
    const current = parseUdsJson<AgentdTask>(poll);
    const lastStatus = current.status ?? "";
    if (["completed", "needs_review", "failed", "cancelled", "blocked"].includes(lastStatus)) {
      return lastStatus;
    }
  }
  return null;
}

/** 把任务终态翻译成给用户的答复 */
function summarizeTask(task: AgentdTask, status: string): string {
  switch (status) {
    case "completed":
      return `任务已完成 ✅（任务 ID: ${task.id ?? "-"}）`;
    case "needs_review":
      return `任务已执行完毕，等待人工终审鉴定（任务 ID: ${task.id ?? "-"}）。`;
    case "failed":
      return `任务执行失败 ❌：${task.lastError ?? "未知错误"}`;
    case "blocked":
      return `任务被阻塞 ⚠️：需要人工介入检查。`;
    case "cancelled":
      return `任务已取消。`;
    case "timeout":
      return `任务仍在执行中（超过 5 分钟）。可在桌面端查看进度。`;
    default:
      return `任务状态: ${status ?? "unknown"}（任务 ID: ${task.id ?? "-"}）`;
  }
}

export const timemProjectTaskService: ServiceDefinition<TimemProjectTaskRequest, TimemProjectTaskResponse> = {
  id: "@orchestration/timem-project-task",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "TiMEM Project 三段式任务工作流: classify(是否任务) → identify(归仓) → dispatch(派发执行)",
};

export const manifest: PluginManifest = {
  name: "@orchestration/timem-project-task",
  layer: LayerId.Orchestration,
  description: "编排层: TiMEM Project 三段式任务工作流(是否任务→归仓→派发)",
  version: "1.0.0",
  provides: [timemProjectTaskService],
  consumes: [llmInferenceRef],
  preferredCarrier: CarrierKind.Thread,
};

export { timemProjectTaskService as service, timemProjectTaskProvider as provider, manifest as timemTaskManifest };
