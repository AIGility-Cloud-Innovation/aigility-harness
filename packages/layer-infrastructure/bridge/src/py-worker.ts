/**
 * PyWorker — Python 子进程生命周期管理 + JSON-RPC 通信.
 *
 * 性能设计:
 *  - 请求队列 + Promise 映射: 多个并发 call 共享一个子进程,
 *    用 id 匹配响应, 不需要串行等待
 *  - 批量调用: callBatch() 一次发多个请求, 一个往返
 *  - 预热: initialize() 在 onLoad 阶段完成, call 阶段零 import 开销
 *  - 进程复用: 一个 PyWorker 服务多个 capability, 避免反复 spawn
 *  - 健康探活: health() 走 JSON-RPC, 不额外开端口
 *  - 优雅退出: dispose() 发 shutdown 请求, 等子进程退出
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err } from "@aigility-harness/core";
import type { Result } from "@aigility-harness/core";
import type {
  JsonRpcResponse,
  RequestHandler,
  RequestMessage,
  WorkerReadyNotification,
  PyWorkerHealth,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// worker 脚本路径: src/ → ../scripts/, dist/ → ../scripts/
function findWorkerScript(): string {
  const candidates = [
    resolve(__dirname, "../scripts/py_bridge_worker.py"),
    resolve(__dirname, "../../scripts/py_bridge_worker.py"),
  ];
  return candidates[0]; // 两个路径都试, spawn 会报错如果不存在
}

export class PyWorker {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readyPromise: Promise<void> | null = null;
  private initialized = new Set<string>();  // 已 initialize 的 cap_id
  private buffer = "";                        // stdout 行缓冲

  /** Python 可执行文件 */
  private readonly pythonExecutable: string;
  /** 工作目录 */
  private readonly workDir?: string;

  constructor(opts?: { pythonExecutable?: string; workDir?: string }) {
    this.pythonExecutable = opts?.pythonExecutable ?? "python3";
    this.workDir = opts?.workDir;
  }

  // ── 生命周期 ──────────────────────────────────────────────────

  /**
   * 启动 Python 子进程, 等待 ready 通知.
   * 幂等: 已启动则直接返回。
   */
  async start(): Promise<Result<void>> {
    if (this.proc && this.proc.exitCode === null) {
      return ok(undefined); // 已在运行
    }

    const script = findWorkerScript();
    this.proc = spawn(this.pythonExecutable, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.workDir,
      env: { ...process.env, PY_BRIDGE_DEBUG: process.env.PY_BRIDGE_DEBUG ?? "" },
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      return err("Failed to spawn Python worker: no stdin/stdout");
    }

    // 等待 ready 通知
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        rejectReady(new Error("Python worker did not send ready notification within 10s"));
      }, 10_000);

      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          // ready 通知
          if ("method" in msg && msg.method === "ready") {
            clearTimeout(timeout);
            resolveReady();
            return;
          }
          // Python→TS 请求 (反向通道): 如 call_capability
          if ("method" in msg && msg.method) {
            void this.handleRequest(msg as RequestMessage);
            return;
          }
          // 批量响应 (数组)[truncated]
          if (Array.isArray(msg)) {
            this.handleBatchResponse(msg as JsonRpcResponse[]);
            return;
          }
          // 单条响应
          this.handleResponse(msg as JsonRpcResponse);
        } catch {
          // 非 JSON 行, 忽略
        }
      };

      this.setupStdout(onLine);
      this.setupStderr();

      this.proc!.once("exit", (code) => {
        clearTimeout(timeout);
        // reject 所有 pending
        for (const [, p] of this.pending) {
          p.reject(new Error(`Python worker exited with code ${code}`));
        }
        this.pending.clear();
        if (code !== 0 && code !== null) {
          rejectReady(new Error(`Python worker exited with code ${code}`));
        }
      });
    });

    try {
      await this.readyPromise;
      return ok(undefined);
    } catch (e) {
      return err(String(e));
    }
  }

  /**
   * 初始化一个 capability (动态 import + 实例化).
   * 幂等: 同一 cap_id 只初始化一次。
   */
  async initialize(
    capId: string,
    config: Record<string, unknown>,
  ): Promise<Result<void>> {
    if (this.initialized.has(capId)) {
      return ok(undefined); // 已初始化
    }

    const resp = await this.send("initialize", {
      capability_id: capId,
      config,
    });
    if (!resp.ok) return resp;

    this.initialized.add(capId);
    return ok(undefined);
  }

  /**
   * 调用一个已初始化的 capability.
   */
  async call(
    capId: string,
    kwargs: Record<string, unknown>,
  ): Promise<Result<unknown>> {
    const resp = await this.send("call", {
      capability_id: capId,
      kwargs,
    });
    return resp;
  }

  /**
   * 批量调用: 一次往返执行多个调用, 减少进程间通信开销.
   */
  async callBatch(
    calls: Array<{ capId: string; kwargs: Record<string, unknown> }>,
  ): Promise<Result<unknown[]>> {
    if (calls.length === 0) {
      return ok([]);
    }

    // 构造批量 JSON-RPC 请求
    const batch = calls.map((c) => ({
      jsonrpc: "2.0" as const,
      id: this.nextId++,
      method: "call" as const,
      params: { capability_id: c.capId, kwargs: c.kwargs },
    }));

    // 为每个请求创建 Promise
    const promises = batch.map(
      (req) =>
        new Promise<unknown>((resolveP, rejectP) => {
          this.pending.set(req.id, { resolve: resolveP, reject: rejectP });
        }),
    );

    // 一次性发送整个 batch
    const batchJson = JSON.stringify(batch) + "\n";
    this.proc?.stdin?.write(batchJson);

    try {
      const results = await Promise.all(promises);
      return ok(results);
    } catch (e) {
      return err(String(e));
    }
  }

  /** 健康检查 */
  async health(): Promise<PyWorkerHealth> {
    const now = new Date().toISOString();
    if (!this.proc || this.proc.exitCode !== null) {
      return { healthy: false, pid: null, capabilities: [], detail: "worker not running", checkedAt: now };
    }

    const resp = await this.send("health", {});
    if (!resp.ok) {
      return { healthy: false, pid: this.proc.pid ?? null, capabilities: [], detail: resp.error, checkedAt: now };
    }

    const data = resp.value as { healthy: boolean; capabilities: string[]; count: number };
    return {
      healthy: data.healthy,
      pid: this.proc.pid ?? null,
      capabilities: data.capabilities,
      detail: `${data.count} capabilities initialized`,
      checkedAt: now,
    };
  }

  /** 优雅关闭 */
  async dispose(): Promise<Result<void>> {
    if (!this.proc) return ok(undefined);

    try {
      await this.send("shutdown", {});
    } catch {
      // shutdown 可能导致进程退出, 忽略错误
    }

    this.proc.stdin?.end();
    this.proc.kill("SIGTERM");

    // 等待退出 (最多 3s)
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        this.proc?.kill("SIGKILL");
        resolveExit();
      }, 3_000);
      this.proc!.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });

    this.proc = null;
    this.pending.clear();
    this.initialized.clear();
    return ok(undefined);
  }

  // ── 内部: JSON-RPC 通信 ───────────────────────────────────────

  private async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<unknown>> {
    if (!this.proc || this.proc.exitCode !== null) {
      return err("Python worker not running");
    }

    const id = this.nextId++;
    const req = { jsonrpc: "2.0" as const, id, method, params };
    const line = JSON.stringify(req) + "\n";

    const promise = new Promise<unknown>((resolveP, rejectP) => {
      this.pending.set(id, { resolve: resolveP, reject: rejectP });
    });

    this.proc.stdin?.write(line);

    try {
      const result = await promise;
      return ok(result);
    } catch (e) {
      return err(String(e));
    }
  }

  private handleResponse(resp: JsonRpcResponse): void {
    const id = resp.id;
    if (id === null) return;

    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);

    if (resp.error) {
      pending.reject(new Error(resp.error.message));
    } else {
      pending.resolve(resp.result);
    }
  }

  /** 处理批量响应 (JSON-RPC 2.0 数组) */
  private handleBatchResponse(responses: JsonRpcResponse[]): void {
    for (const resp of responses) {
      this.handleResponse(resp);
    }
  }

  // ── Python→TS 反向通道 ───────────────────────────────────────

  private requestHandlers = new Map<string, RequestHandler>();

  /** 注册反向请求处理器 (method → handler) */
  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** 处理 Python worker 发起的反向请求: 执行 handler, 结果写回 stdin */
  private async handleRequest(msg: RequestMessage): Promise<void> {
    const t0 = Date.now();
    console.log(`[py-worker] 收到反向请求 method=${msg.method} id=${msg.id ?? "?"}`);
    const handler = this.requestHandlers.get(msg.method);
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: msg.id ?? null,
    };

    try {
      if (!handler) {
        resp.error = {
          code: -32601,
          message: `No handler registered for method '${msg.method}'`,
        };
      } else {
        resp.result = await handler(msg.params ?? {}, msg.id ?? 0);
      }
    } catch (e) {
      resp.error = {
        code: -32603,
        message: e instanceof Error ? e.message : String(e),
      };
    }

    if (this.proc?.stdin) {
      this.proc.stdin.write(JSON.stringify(resp) + "\n");
      console.log(`[py-worker] 反向请求 ${msg.method} 已响应 (${Date.now() - t0}ms) id=${msg.id ?? "?"}`);
    } else {
      console.log(`[py-worker] ⚠️ 无 stdin, 无法响应 ${msg.method}`);
    }
  }

  private setupStdout(onLine: (line: string) => void): void {
    this.proc!.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? ""; // 最后一段不完整, 留在 buffer
      for (const line of lines) {
        if (line.trim()) onLine(line.trim());
      }
    });
  }

  private setupStderr(): void {
    this.proc!.stderr!.on("data", (chunk: Buffer) => {
      // Python stderr → Node stderr (调试用)
      process.stderr.write(chunk);
    });
  }
}
