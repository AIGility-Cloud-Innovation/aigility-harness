/**
 * @aigility-harness/py-bridge — 通用 Python 对接器
 *
 * 声明式配置接入任意 Python 包, JSON-RPC over stdio, 零端口.
 * Python 仓库不需要改一行代码。
 *
 * 用法:
 *   import { createPyBridgePlugin, loadPyPluginsConfig } from "@aigility-harness/py-bridge";
 *
 *   const configs = loadPyPluginsConfig("config/py-plugins.json");
 *   const plugin = createPyBridgePlugin(configs);
 *   // → 加入 bootstrap plugins 数组即可
 */

// Provider 工厂
export {
  createPyBridgePlugin,
  createPyBridgeProviders,
} from "./py-bridge.js";
export type { PyBridgeProvider } from "./py-bridge.js";

// 配置加载
export {
  loadPyPluginsConfig,
  flattenCapabilities,
} from "./config-loader.js";

// Worker (高级用法: 直接操作 worker)
export { PyWorker } from "./py-worker.js";

// 类型
export type {
  PyPluginConfig,
  PyCapabilityMapping,
  JsonRpcRequest,
  JsonRpcResponse,
  WorkerReadyNotification,
  PyWorkerHealth,
} from "./types.js";
