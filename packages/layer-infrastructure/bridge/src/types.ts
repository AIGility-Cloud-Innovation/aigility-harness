/**
 * py-bridge 类型定义 — 声明式配置 + 通信协议类型.
 *
 * 配置文件 (py-plugins.yaml) 描述哪些 Python 包、哪些函数、
 * 映射到哪个 Seam 能力。TS 侧读配置后自动生成 ServiceDefinition + Provider。
 */

import type { LayerId } from "@aigility-harness/core";

// ── 声明式配置结构 ────────────────────────────────────────────────

/**
 * 单个 Python 能力映射.
 * 一个 Python 函数/方法 → 一个 Seam Capability。
 */
export interface PyCapabilityMapping {
  /** Seam 能力 ID, e.g. "@cognitive/rag-retrieval" */
  id: string;

  /** 目标层 */
  layer: LayerId;

  /**
   * Python 对象路径, e.g. "aigility.rag.RAGService".
   * 如果是类, 会用 init 参数实例化。
   * 如果是函数, 直接调用。
   */
  function: string;

  /**
   * 可选: 实例方法名, e.g. "search".
   * 如果 function 指向类, method 指向实例方法。
   * 如果省略, function 本身必须是 callable。
   */
  method?: string;

  /** 初始化参数 (构造函数参数或首次调用参数) */
  init?: Record<string, unknown>;

  /** 环境变量注入 (初始化前设置) */
  env?: Record<string, string>;

  /**
   * 请求字段映射: Seam Request 字段名 → Python kwargs 字段名.
   * 省略表示同名直传。
   * 例: { "query": "query", "topK": "top_k" }
   */
  requestMapping?: Record<string, string>;

  /**
   * 响应字段映射: Python 返回字段名 → Seam Response 字段名.
   * 省略表示原样返回整个 Python 结果。
   */
  responseMapping?: Record<string, string>;
}

/**
 * 一个 Python 插件配置.
 * 对应一个 Python 包/venv, 可包含多个 capability。
 */
export interface PyPluginConfig {
  /** 插件名 (用于日志和 Provider 命名) */
  name: string;

  /** Python 模块根 (用于 import, e.g. "aigility.rag") */
  pythonModule: string;

  /**
   * Python 可执行文件路径.
   * 默认 "python3".
   * 可指定 venv 中的 python: ".venv/bin/python"
   */
  pythonExecutable?: string;

  /**
   * 工作目录 (Python 进程的 cwd).
   * 默认继承父进程。
   */
  workDir?: string;

  /** 该插件提供的所有能力映射 */
  capabilities: PyCapabilityMapping[];
}

// ── JSON-RPC 协议类型 ────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: "initialize" | "call" | "health" | "shutdown";
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

/** Worker 启动后发来的 ready 通知 */
export interface WorkerReadyNotification {
  jsonrpc: "2.0";
  method: "ready";
  params: { pid: number; python: string };
}

// ── 运行时类型 ────────────────────────────────────────────────────

/** PyWorker 健康状态 */
export interface PyWorkerHealth {
  healthy: boolean;
  pid: number | null;
  capabilities: string[];
  detail: string;
  checkedAt: string;
}
