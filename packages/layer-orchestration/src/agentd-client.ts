/**
 * agentd-client — timem-project agentd 的 UDS HTTP 客户端（编排层共享模块）
 *
 * 从 timem-project-task.ts 纯搬运抽出，供其与 task-issue-sync（派发域）共用。
 * 只封装 transport + agentd REST 原语，不含任何业务决策：
 *   - UDS socket 请求（node http.request socketPath + Bearer token）
 *   - create-from-message / confirm-project / confirm-prompt / run / cancel / get / list
 *
 * 硬约束：timem-project 仓库代码零改动，只消费其现成 API 面
 * （cmd/timem-agentd/http.go 路由：POST /v1/tasks...，见各方法注释）。
 */
import { request as httpRequest } from "node:http";

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

export interface UdsResponse {
  status: number;
  body: string;
}

export function udsRequest(
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
          console.log(`[agentd-client] UDS ${method} ${path} → HTTP ${res.statusCode} body=${data.slice(0, 200)}`);
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
export function parseUdsJson<T>(resp: UdsResponse): T {
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

// ---- 任务类型 ----

export interface AgentdTask {
  id?: string;
  status?: string;
  projectId?: string;
  title?: string;
  description?: string;
  lastError?: string;
  sourceMessageId?: string;
  sourceConversationId?: string;
  createdAt?: string;
}

export interface CreateFromMessageResult {
  id?: string;
  taskId?: string;
  status?: string;
  pending_project?: boolean;
  prompt?: string;
  [key: string]: unknown;
}

/** agentd 侧可取消的任务状态（与 timem-project CancelTask 准入一致） */
export const CANCELABLE_STATUSES = ["pending_confirm", "pending_project", "queued", "running"];

/** agentd 侧终态（轮询出口） */
export const FINAL_STATUSES = ["completed", "needs_review", "failed", "cancelled", "blocked"];

/** 轮询参数（env 可覆盖） */
export function pollIntervalMs(): number {
  const env = Number(process.env["TIMEM_TASK_POLL_INTERVAL_MS"]);
  return Number.isFinite(env) && env > 0 ? env : 2_000;
}

export function pollTimeoutMs(): number {
  const env = Number(process.env["TIMEM_TASK_POLL_TIMEOUT_MS"]);
  return Number.isFinite(env) && env > 0 ? env : 5 * 60_000;
}

// ---- agentd REST 原语（路由见 timem-project cmd/timem-agentd/http.go）----

export interface AgentdEndpoint {
  socketPath: string;
  token: string;
}

function ep(endpoint: AgentdEndpoint): [string, string] {
  return [endpoint.socketPath, endpoint.token];
}

/** POST /v1/tasks/create-from-message — 建任务(高置信项目直接落 pending_confirm) */
export async function createFromMessage(
  endpoint: AgentdEndpoint,
  body: {
    source?: string;
    sourceMessageId?: string;
    sourceConversationID?: string;
    sourceConversationId?: string;
    replyToMessageId?: string;
    senderId?: string;
    senderType?: string;
    text?: string;
    title?: string;
    description?: string;
    projectId?: string;
    trigger?: string;
  },
): Promise<CreateFromMessageResult> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "POST", "/v1/tasks/create-from-message", body);
  return parseUdsJson<CreateFromMessageResult>(resp);
}

/** GET /v1/projects — 已注册项目列表 */
export async function listProjects(
  endpoint: AgentdEndpoint,
): Promise<Array<{ id?: string; name?: string; rootPaths?: string[]; available?: boolean }>> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "GET", "/v1/projects");
  return parseUdsJson(resp);
}

/** POST /v1/projects — 注册项目（id 短名，rootPaths 为本地绝对路径） */
export async function registerProject(
  endpoint: AgentdEndpoint,
  body: { id: string; name: string; rootPaths: string[]; order?: number; available?: boolean },
): Promise<{ id?: string; name?: string }> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "POST", "/v1/projects", body);
  return parseUdsJson(resp);
}

/** POST /v1/tasks/{id}/confirm-project — 项目归属确认(pending_project → pending_confirm) */
export async function confirmProject(
  endpoint: AgentdEndpoint,
  taskId: string,
  projectId: string,
): Promise<AgentdTask> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "POST", `/v1/tasks/${taskId}/confirm-project`, { projectId });
  return parseUdsJson<AgentdTask>(resp);
}

/**
 * POST /v1/tasks/{id}/confirm-prompt — 提示词确认(pending_confirm → queued)。
 * delayMs>0: queued 后由 agentd scheduleLoop(30s) 定时自动 run；
 * runNow=true: 额外带 delayMs=1000 近似立即；等人工则 delayMs 不传(默认 1h)或 0。
 */
export async function confirmPrompt(
  endpoint: AgentdEndpoint,
  taskId: string,
  opts: { promptOverride?: string; delayMs?: number; runNow?: boolean } = {},
): Promise<AgentdTask> {
  const [socketPath, token] = ep(endpoint);
  const body: Record<string, unknown> = {};
  if (opts.promptOverride && opts.promptOverride.trim()) body.promptOverride = opts.promptOverride.trim();
  if (opts.runNow) body.delayMs = 1000;
  else if (opts.delayMs !== undefined) body.delayMs = opts.delayMs;
  const resp = await udsRequest(socketPath, token, "POST", `/v1/tasks/${taskId}/confirm-prompt`, body);
  return parseUdsJson<AgentdTask>(resp);
}

/** POST /v1/tasks/{id} — 取消(pending_confirm/pending_project/queued/running) */
export async function cancelTask(endpoint: AgentdEndpoint, taskId: string): Promise<AgentdTask> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "DELETE", `/v1/tasks/${taskId}`);
  const parsed = parseUdsJson<AgentdTask | null>(resp);
  return { id: taskId, ...(parsed ?? {}), status: parsed?.status ?? "cancelled" };
}

/** GET /v1/tasks/{id} — 查单个任务 */
export async function getTask(endpoint: AgentdEndpoint, taskId: string): Promise<AgentdTask> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "GET", `/v1/tasks/${taskId}`);
  const parsed = parseUdsJson<AgentdTask | null>(resp);
  // 兜底：部分响应体只带 error/message 不带 id，注入调用方已知的 id
  return { id: taskId, ...(parsed ?? {}) };
}

/** POST /v1/tasks/{id}/run — 立即执行(queued 可直接 run；会清除定时，提前执行)。
 *  实测（2026-09-26 活体）：run 受理后任务转 preparing 异步执行，响应体为字面量 null。 */
export async function runTask(endpoint: AgentdEndpoint, taskId: string): Promise<AgentdTask> {
  const [socketPath, token] = ep(endpoint);
  const resp = await udsRequest(socketPath, token, "POST", `/v1/tasks/${taskId}/run`, {});
  const parsed = parseUdsJson<AgentdTask | null>(resp);
  return parsed ?? { id: taskId, status: "preparing" };
}

/** GET /v1/tasks?status=… — 列任务(可选状态过滤) */
export async function listTasks(
  endpoint: AgentdEndpoint,
  filter: { status?: string } = {},
): Promise<AgentdTask[]> {
  const [socketPath, token] = ep(endpoint);
  const qs = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  const resp = await udsRequest(socketPath, token, "GET", `/v1/tasks${qs}`);
  const parsed = parseUdsJson<AgentdTask[] | { tasks?: AgentdTask[] }>(resp);
  return Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
}

/**
 * 轮询到终态(FINAL_STATUSES 之一)，超时返回 null。
 * 注意：轮询期间任务可能还在 queued 等定时——只到终态才返回。
 */
export async function pollTaskUntilFinal(
  endpoint: AgentdEndpoint,
  taskId: string,
): Promise<string | null> {
  const deadline = Date.now() + pollTimeoutMs();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs()));
    const current = await getTask(endpoint, taskId);
    const status = current.status ?? "";
    if (FINAL_STATUSES.includes(status)) return status;
  }
  return null;
}
