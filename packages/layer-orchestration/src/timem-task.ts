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

// ---- 请求/响应 ----

export interface TimemTaskRequest {
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
  /** 聊天类型: p2p | group */
  chat_type?: string;
  /** 资源引用(图片等, 目前透传不消费) */
  resources?: Array<Record<string, unknown>>;
}

export type TimemTaskResponse =
  | { type: "chat"; text: string }
  | { type: "ask"; text: string }
  | { type: "task"; taskId: string; status: string; response: string }
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
      model: "qwen2.5:7b",
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0,
    };
    const res = (await ctx.call<LlmInferenceRequest, LlmInferenceResponse>(
      llmInferenceRef,
      req,
    )) as Result<LlmInferenceResponse>;
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
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

// ---- Provider 实现 ----

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 分钟轮询上界

let activeSocketPath = defaultSocketPath();
let activeToken = defaultToken();

/** 运行时覆盖配置(装配时可注入) */
export function enableTimemTask(options: { socketPath?: string; token?: string }): void {
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

export const timemTaskProvider: Provider<TimemTaskRequest, TimemTaskResponse> = {
  service: {
    id: "@orchestration/timem-task",
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
    request: TimemTaskRequest,
    ctx: SeamContext,
    _options?: { socketPath?: string; token?: string },
  ): Promise<Result<TimemTaskResponse>> {
    const socketPath = _options?.socketPath ?? activeSocketPath;
    const token = _options?.token ?? activeToken;
    const source = request.source ?? "feishu";

    if (!request.user_input?.trim()) {
      return err("任务指令为空");
    }

    try {
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

      // ② identify: 归仓(显式 project_id 优先; 仍调 identify-project 以取 rootPaths 供 git 校验)
      const identifyBody = {
        text: request.user_input,
        conversationId: request.conversation_id ?? request.session_id ?? ctx.sessionId,
        senderId: request.user_id ?? "",
        ...(request.project_id ? { projectId: request.project_id } : {}),
      };
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
      const taskId = created.id ?? "";
      if (!taskId) {
        return ok({
          type: "error",
          text: `agentd 创建任务失败: ${created.lastError ?? "未知错误"}`,
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

interface CreateFromMessageResult {
  id?: string;
  status?: string;
  lastError?: string;
  contextGate?: AgentdContextGate | null;
  pending_project?: boolean;
}

async function dispatch(
  socketPath: string,
  token: string,
  source: string,
  request: TimemTaskRequest,
  projectId: string,
): Promise<CreateFromMessageResult | null> {
  const createBody = {
    source,
    sourceMessageId: request.session_id ?? "",
    sourceConversationId: request.conversation_id ?? request.session_id ?? "",
    title: request.title ?? request.user_input.slice(0, 80),
    description: request.user_input,
    projectId,
  };
  const created = await activeHooks.udsRequest(
    socketPath,
    token,
    "POST",
    "/v1/tasks/create-from-message",
    createBody,
  );
  const task = parseUdsJson<CreateFromMessageResult>(created);
  const taskId = task.id ?? "";
  if (!taskId) return null;

  // 若仍需项目确认或触发 contextGate → 确认后执行
  if (task.pending_project || task.contextGate) {
    const confirm = await activeHooks.udsRequest(
      socketPath,
      token,
      "POST",
      `/v1/tasks/${taskId}/confirm-project`,
      { projectId },
    );
    parseUdsJson<AgentdTask>(confirm);
  }

  // 执行
  const run = await activeHooks.udsRequest(socketPath, token, "POST", `/v1/tasks/${taskId}/run`, {});
  parseUdsJson<AgentdTask>(run);
  return task;
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

export const timemTaskService: ServiceDefinition<TimemTaskRequest, TimemTaskResponse> = {
  id: "@orchestration/timem-task",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "TiMEM Project 三段式任务工作流: classify(是否任务) → identify(归仓) → dispatch(派发执行)",
};

export const manifest: PluginManifest = {
  name: "@orchestration/timem-task",
  layer: LayerId.Orchestration,
  description: "编排层: TiMEM Project 三段式任务工作流(是否任务→归仓→派发)",
  version: "1.0.0",
  provides: [timemTaskService],
  consumes: [llmInferenceRef],
  preferredCarrier: CarrierKind.Thread,
};

export { timemTaskService as service, timemTaskProvider as provider, manifest as timemTaskManifest };
