/**
 * L4 编排层: timem-task — TiMEM Project 真实执行桥接
 *
 * 替换「原型 stub workflow-engine」占位, 把任务通过 UDS HTTP 递进 timem-project
 * agentd 执行（关键价值留在 agentd：加密上下文/审计账本/白名单验收）。
 *
 * 设计见 timem-project/docs/timem-task-bridge-design.md:
 *   - 通信: Unix Domain Socket + HTTP 语义 (agentd.sock)
 *   - 鉴权: Bearer token (agentd 启动随机生成; harness 从 env TIMEM_AGENTD_TOKEN 读)
 *   - 流程: create -> (confirm-project if pending_project) -> run -> poll status
 */
import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
  err,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { request as httpRequest } from "node:http";

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
  /** 项目 ID: 显式指定时直接确认该项目 */
  project_id?: string;
}

export interface TimemTaskResponse {
  task_id: string;
  status: string;
  /** 最终答复(执行结果/错误/超时说明) */
  response: string;
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

// ---- 服务定义 ----

export const timemTaskService: ServiceDefinition<TimemTaskRequest, TimemTaskResponse> = {
  id: "@orchestration/timem-task",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "TiMEM Project 真实执行桥接: UDS HTTP 递任务进 agentd (create→confirm→run→poll)",
};

export const manifest: PluginManifest = {
  name: "@orchestration/timem-task",
  layer: LayerId.Orchestration,
  description: "编排层: TiMEM Project 任务执行桥接(替代原型 stub)",
  version: "1.0.0",
  provides: [timemTaskService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

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

export const timemTaskProvider: Provider<TimemTaskRequest, TimemTaskResponse> = {
  service: timemTaskService,
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
    _ctx: SeamContext,
  ): Promise<Result<TimemTaskResponse>> {
    const socketPath = activeSocketPath;
    const token = activeToken;
    const source = request.source ?? "feishu";

    if (!request.user_input?.trim()) {
      return err("任务指令为空");
    }

    try {
      // 1. 创建任务
      const createBody = {
        source,
        sourceMessageId: request.session_id ?? "",
        sourceConversationId: request.session_id ?? "",
        title: request.title ?? request.user_input.slice(0, 80),
        description: request.user_input,
      };
      const created = await udsRequest(socketPath, token, "POST", "/v1/tasks", createBody);
      const task = parseUdsJson<AgentdTask>(created);
      const taskId = task.id ?? "";
      if (!taskId) {
        return err(`agentd 创建任务失败: ${created.body.slice(0, 200)}`);
      }

      // 2. 若需项目确认
      if (task.status === "pending_project" || request.project_id) {
        const projectId = request.project_id ?? "standalone";
        const confirm = await udsRequest(
          socketPath,
          token,
          "POST",
          `/v1/tasks/${taskId}/confirm-project`,
          { projectId },
        );
        parseUdsJson<AgentdTask>(confirm);
      }

      // 3. 执行
      const run = await udsRequest(socketPath, token, "POST", `/v1/tasks/${taskId}/run`, {});
      parseUdsJson<AgentdTask>(run);

      // 4. 轮询状态
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let lastStatus = "";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await udsRequest(socketPath, token, "GET", `/v1/tasks/${taskId}`);
        const current = parseUdsJson<AgentdTask>(poll);
        lastStatus = current.status ?? "";
        if (["completed", "needs_review", "failed", "cancelled", "blocked"].includes(lastStatus)) {
          break;
        }
      }

      return ok({
        task_id: taskId,
        status: lastStatus || "timeout",
        response: summarizeTask(task, lastStatus),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ECONNREFUSED") || msg.includes("ENOENT")) {
        return err(`执行引擎未就绪（agentd 未启动或 socket 不存在: ${socketPath}）。请稍后重试。`);
      }
      return err(`执行失败: ${msg}`);
    }
  },
};

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

export { timemTaskService as service, timemTaskProvider as provider, manifest as timemTaskManifest };
