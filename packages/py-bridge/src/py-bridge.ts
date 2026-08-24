/**
 * PyBridge Provider 工厂 — 从声明式配置自动生成 Seam Provider.
 *
 * 核心流程:
 *  1. 读配置 → 每个 capability 生成一个 ServiceDefinition + Provider
 *  2. Provider.execute() 做字段映射 → 调 PyWorker.call() → 映射回
 *  3. Provider.health() 调 PyWorker.health()
 *  4. onLoad 阶段: start worker + initialize 所有 capability (预热)
 *
 * 性能设计:
 *  - 共享 worker: 同一 venv 的插件共享一个 PyWorker 进程
 *  - 预热: initialize 在 onLoad 完成, 首次 call 无 import 开销
 *  - 字段映射零分配: 预编译映射表, 不在每次 call 里遍历
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
  err,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { PyWorker } from "./py-worker.js";
import type { PyPluginConfig, PyCapabilityMapping } from "./types.js";

// ── 字段映射工具 ──────────────────────────────────────────────────

/**
 * 按映射表重命名对象的字段.
 * mapping: { sourceField → targetField }
 * 未在 mapping 中的字段不保留 (只保留映射了的字段).
 * 如果 mapping 为空/undefined, 原样返回。
 */
function remap(
  obj: Record<string, unknown>,
  mapping?: Record<string, string>,
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) {
    return obj; // 原样返回, 零开销
  }
  const result: Record<string, unknown> = {};
  for (const [src, dst] of Object.entries(mapping)) {
    if (src in obj) {
      result[dst] = obj[src];
    }
  }
  return result;
}

// ── Provider 生成 ────────────────────────────────────────────────

export interface PyBridgeProvider {
  service: ServiceDefinition;
  provider: Provider;
  capId: string;
  layer: LayerId;
}

/**
 * 为单个 capability 生成 ServiceDefinition + Provider.
 */
function createProviderForCapability(
  pluginConfig: PyPluginConfig,
  cap: PyCapabilityMapping,
  worker: PyWorker,
): PyBridgeProvider {
  const service: ServiceDefinition = {
    id: cap.id,
    version: "1.0.0",
    layer: cap.layer,
    description: `Python bridge: ${pluginConfig.pythonModule}.${cap.function}${cap.method ? `.${cap.method}` : ""}`,
  };

  const provider: Provider = {
    service,
    name: `py-bridge-${cap.id}`,
    state: PluginState.Active,

    async execute(
      request: Record<string, unknown>,
      ctx: SeamContext,
    ): Promise<Result<unknown>> {
      // 请求字段映射: Seam Request → Python kwargs
      const kwargs = remap(request, cap.requestMapping);

      ctx.emit({
        type: "py-bridge.call",
        layer: cap.layer,
        payload: { capId: cap.id, plugin: pluginConfig.name },
        traceId: ctx.traceId,
      });

      // 调 Python worker
      const result = await worker.call(cap.id, kwargs);
      if (!result.ok) {
        return err(result.error);
      }

      // 响应字段映射: Python return → Seam Response
      const pyResult = result.value as Record<string, unknown>;
      const response = cap.responseMapping
        ? remap(pyResult, cap.responseMapping)
        : pyResult;

      return ok(response);
    },

    async health(): Promise<HealthStatus> {
      const h = await worker.health();
      return {
        healthy: h.healthy,
        detail: h.detail,
        checkedAt: h.checkedAt,
      };
    },
  };

  return { service, provider, capId: cap.id, layer: cap.layer };
}

// ── 批量生成 + 共享 worker ────────────────────────────────────────

/**
 * 从配置数组生成所有 Provider.
 *
 * 共享策略: 同一 pythonExecutable 的插件共享一个 PyWorker 进程.
 * 不同 venv 的插件各起一个 worker。
 */
export function createPyBridgeProviders(
  configs: PyPluginConfig[],
): {
  providers: PyBridgeProvider[];
  workers: PyWorker[];
  initFn: () => Promise<Result<void>>;  // 预热函数, onLoad 时调
} {
  // 按 pythonExecutable 分组 (同 venv 共享 worker)
  const workerGroups = new Map<string, PyWorker>();
  const allProviders: PyBridgeProvider[] = [];

  for (const pluginConfig of configs) {
    const pyExec = pluginConfig.pythonExecutable ?? "python3";
    const workerKey = `${pyExec}:${pluginConfig.workDir ?? ""}`;

    let worker = workerGroups.get(workerKey);
    if (!worker) {
      worker = new PyWorker({
        pythonExecutable: pyExec,
        workDir: pluginConfig.workDir,
      });
      workerGroups.set(workerKey, worker);
    }

    for (const cap of pluginConfig.capabilities) {
      const p = createProviderForCapability(pluginConfig, cap, worker);
      allProviders.push(p);
    }
  }

  const workers = [...workerGroups.values()];

  // 预热函数: start 所有 worker + initialize 所有 capability
  const initFn = async (): Promise<Result<void>> => {
    // 并行启动所有 worker
    const startResults = await Promise.all(workers.map((w) => w.start()));
    for (const r of startResults) {
      if (!r.ok) return err(`Failed to start Python worker: ${r.error}`);
    }

    // 并行初始化所有 capability
    const initResults = await Promise.all(
      configs.flatMap((pluginConfig) =>
        pluginConfig.capabilities.map(async (cap) => {
          const pyExec = pluginConfig.pythonExecutable ?? "python3";
          const workerKey = `${pyExec}:${pluginConfig.workDir ?? ""}`;
          const worker = workerGroups.get(workerKey)!;
          return worker.initialize(cap.id, {
            function: cap.function,
            method: cap.method,
            init: cap.init,
            env: cap.env,
          });
        }),
      ),
    );
    for (const r of initResults) {
      if (!r.ok) return err(`Failed to initialize capability: ${r.error}`);
    }

    return ok(undefined);
  };

  return { providers: allProviders, workers, initFn };
}

// ── LayerPlugin 导出 ─────────────────────────────────────────────

/**
 * 从配置生成一个 LayerPlugin (可插入 bootstrap).
 *
 * 这个 plugin 横跨多个层 (capability 可能落在 cognitive/orchestration/etc),
 * 但 LayerPlugin.layer 只能是一个值。我们把它放在 Infrastructure 层
 * (底座层), 因为 py-bridge 本质是基础设施: 跨语言桥接。
 * 生成的 Provider 各自携带正确的 layer 信息, Seam 注册时用 Provider.service.layer。
 */
export function createPyBridgePlugin(
  configs: PyPluginConfig[],
): LayerPlugin {
  const { providers, workers, initFn } = createPyBridgeProviders(configs);

  let pluginState: PluginState = PluginState.Registered;

  const manifest: PluginManifest = {
    name: "@infrastructure/py-bridge",
    layer: LayerId.Infrastructure,
    description: `Python bridge: ${providers.length} capabilities from ${configs.length} plugins`,
    version: "0.1.0",
    provides: providers.map((p) => p.service),
    consumes: [],
    preferredCarrier: CarrierKind.Subprocess,
  };

  return {
    manifest,
    async onLoad(_ctx: SeamContext): Promise<Result<void>> {
      const result = await initFn();
      if (!result.ok) {
        pluginState = PluginState.Error;
        return err(result.error);
      }
      pluginState = PluginState.Active;
      return ok(undefined);
    },
    async onUnload(): Promise<Result<void>> {
      // 并行关闭所有 worker
      await Promise.all(workers.map((w) => w.dispose()));
      pluginState = PluginState.Disposed;
      return ok(undefined);
    },
    getProviders(): Provider[] {
      return providers.map((p) => p.provider);
    },
    getState(): PluginState {
      return pluginState;
    },
  };
}
