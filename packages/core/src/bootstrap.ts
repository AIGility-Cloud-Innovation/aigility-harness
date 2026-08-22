/**
 * Bootstrap — the system entry point.
 *
 * Orchestrates kernel initialization, layer ordering, plugin loading,
 * and scheduler startup.  This is the only place that wires concrete
 * instances together; everything else depends on interfaces.
 */

import type { KernelAdapter, KernelConfig } from "./kernel-adapter.js";
import type { LayerPlugin, LayerDescriptor } from "./layer-plugin.js";
import type { Scheduler } from "./scheduler.js";
import type { LayerId, Result, RunMode } from "./types.js";
import { ok, err } from "./types.js";
import { LAYER_DESCRIPTORS } from "./layer-plugin.js";
import { LayerId as L, RunMode as RM } from "./types.js";

// ── Bootstrap Config ─────────────────────────────────────────────

export interface BootstrapConfig {
  kernel: KernelAdapter;
  kernelConfig: KernelConfig;
  /** All plugins to load, across all layers */
  plugins: LayerPlugin[];
  /** Scheduler instance (optional; created if not provided) */
  scheduler?: Scheduler;
}

// ── Topological Sort ─────────────────────────────────────────────

/**
 * Sort layers by dependency order.  Infrastructure first, then
 * Cognitive, then Perception/Orchestration, then Action.
 */
function sortLayers(): LayerDescriptor[] {
  const sorted: LayerDescriptor[] = [];
  const visited = new Set<LayerId>();

  function visit(id: LayerId): void {
    if (visited.has(id)) return;
    visited.add(id);
    const desc = LAYER_DESCRIPTORS[id];
    for (const dep of desc.dependsOn) {
      visit(dep);
    }
    sorted.push(desc);
  }

  for (const id of Object.values(L)) {
    visit(id);
  }

  return sorted;
}

/**
 * Sort plugins by their `dependsOn` declarations within each layer.
 */
function sortPluginsWithinLayer(plugins: LayerPlugin[]): LayerPlugin[] {
  const sorted: LayerPlugin[] = [];
  const visited = new Set<string>();

  function visit(plugin: LayerPlugin): void {
    if (visited.has(plugin.manifest.name)) return;
    visited.add(plugin.manifest.name);

    for (const dep of plugin.manifest.dependsOn ?? []) {
      const depPlugin = plugins.find((p) => p.manifest.name === dep);
      if (depPlugin) visit(depPlugin);
    }

    sorted.push(plugin);
  }

  for (const p of plugins) visit(p);
  return sorted;
}

// ── Bootstrap ────────────────────────────────────────────────────

export async function bootstrap(
  config: BootstrapConfig,
): Promise<Result<{ kernel: KernelAdapter; scheduler?: Scheduler }>> {
  const { kernel, kernelConfig, plugins, scheduler } = config;

  // 1. Initialize kernel
  const initResult = await kernel.init(kernelConfig);
  if (!initResult.ok) {
    return err(`Kernel init failed: ${initResult.error}`);
  }

  // 2. Sort layers by dependency
  const layerOrder = sortLayers();

  // 3. For each layer, in order, load its plugins
  for (const layerDesc of layerOrder) {
    const layerPlugins = plugins.filter(
      (p) => p.manifest.layer === layerDesc.id,
    );
    const sorted = sortPluginsWithinLayer(layerPlugins);

    for (const plugin of sorted) {
      // Determine carrier
      const carrier =
        kernelConfig.mode === RM.Prototype
          ? layerDesc.prototypeCarrier
          : layerDesc.productionCarrier;

      // Launch plugin in the selected carrier
      const launchResult = await kernel.carriers.launch(plugin, carrier);
      if (!launchResult.ok) {
        return err(
          `Failed to launch plugin ${plugin.manifest.name}: ${launchResult.error}`,
        );
      }

      // Register providers with the Seam registry
      const providers = plugin.getProviders();
      for (const provider of providers) {
        const regResult = await kernel.registry.register(
          provider.service,
          provider,
        );
        if (!regResult.ok) {
          return err(
            `Failed to register provider ${provider.name}: ${regResult.error}`,
          );
        }
      }
    }
  }

  // 4. Start the scheduler
  if (scheduler) {
    scheduler.start();
  }

  return ok({ kernel, scheduler });
}

// ── Shutdown ────────────────────────────────────────────────────

export async function shutdown(
  kernel: KernelAdapter,
  scheduler?: Scheduler,
): Promise<Result<void>> {
  scheduler?.stop();

  // Stop all plugin handles
  const handles = kernel.carriers.list();
  for (const handle of handles) {
    await kernel.carriers.stop(handle);
  }

  return kernel.shutdown();
}
