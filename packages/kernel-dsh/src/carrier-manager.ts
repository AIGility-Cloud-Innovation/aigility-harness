/**
 * CarrierManager — implements the `CarrierManager` contract.
 *
 * Carrier support matrix (prototype mode):
 *  - Thread:        fully supported (in-process plugin activation)
 *  - Subprocess:    fully supported (simulated in-process; tracked as a
 *                    distinct carrier so migrate/health behave correctly)
 *  - Daemon:        not supported → returns "prototype mode unsupported"
 *  - NetworkService: not supported → returns "prototype mode unsupported"
 *
 * `launch` invokes `plugin.onLoad` with a SeamContext, tracks a
 * `PluginHandle`, and records the plugin for `list`/`health`/`stop`.
 * `stop` invokes `plugin.onUnload` (if present) and removes the handle.
 * `migrate` stops the plugin in the old carrier and relaunches in the new
 * one (hot), preserving the plugin instance.
 *
 * Pure delegation: no business logic beyond carrier lifecycle translation.
 */

import {
  CarrierKind,
  PluginState,
} from "@aigility-harness/core";
import type {
  HealthStatus,
  Result,
} from "@aigility-harness/core";
import type {
  CarrierManager,
  PluginHandle,
  LayerPlugin,
  SeamContext,
  LayerId,
} from "@aigility-harness/core";
import { err, ok } from "@aigility-harness/core";

interface TrackedPlugin {
  handle: PluginHandle;
  plugin: LayerPlugin;
  /** Context used for onLoad; reused for onUnload tracking. */
  ctx: SeamContext;
}

const UNSUPPORTED = new Set<CarrierKind>([
  "daemon" as CarrierKind,
  "network-service" as CarrierKind,
]);

function unsupported(carrier: CarrierKind): string {
  return `carrier "${carrier}" is not supported in prototype mode`;
}

export type ContextFactory = (
  sessionId: string,
  layer: LayerId,
) => SeamContext;

export class DshCarrierManager implements CarrierManager {
  private readonly handles = new Map<string, TrackedPlugin>();
  private counter = 0;
  private readonly contextFactory: ContextFactory;

  constructor(contextFactory: ContextFactory) {
    this.contextFactory = contextFactory;
  }

  async launch(
    plugin: LayerPlugin,
    carrier: CarrierKind,
  ): Promise<Result<PluginHandle>> {
    if (UNSUPPORTED.has(carrier)) {
      return err(unsupported(carrier));
    }

    const id = `plugin-${++this.counter}`;
    const handle: PluginHandle = {
      id,
      name: plugin.manifest.name,
      layer: plugin.manifest.layer,
      carrier,
      state: PluginState.Initializing,
    };

    const ctx = this.contextFactory(id, plugin.manifest.layer);
    this.handles.set(id, { handle, plugin, ctx });

    const loadResult = await plugin.onLoad(ctx);
    if (!loadResult.ok) {
      this.handles.delete(id);
      handle.state = PluginState.Error;
      return err(loadResult.error);
    }

    handle.state = plugin.getState();
    return ok(handle);
  }

  async stop(handle: PluginHandle): Promise<Result<void>> {
    const tracked = this.handles.get(handle.id);
    if (!tracked) {
      return err(`plugin not found: ${handle.id}`);
    }

    tracked.handle.state = PluginState.Disposing;
    if (tracked.plugin.onUnload) {
      const result = await tracked.plugin.onUnload();
      if (!result.ok) {
        tracked.handle.state = PluginState.Error;
        return err(result.error);
      }
    }
    tracked.handle.state = PluginState.Disposed;
    this.handles.delete(handle.id);
    return ok(undefined);
  }

  async migrate(
    handle: PluginHandle,
    toCarrier: CarrierKind,
  ): Promise<Result<PluginHandle>> {
    const tracked = this.handles.get(handle.id);
    if (!tracked) {
      return err(`plugin not found: ${handle.id}`);
    }
    if (UNSUPPORTED.has(toCarrier)) {
      return err(unsupported(toCarrier));
    }

    // Hot migration: stop then relaunch in the new carrier.
    const stopResult = await this.stop(handle);
    if (!stopResult.ok) {
      return err(stopResult.error);
    }
    return this.launch(tracked.plugin, toCarrier);
  }

  async health(handle: PluginHandle): Promise<HealthStatus> {
    const tracked = this.handles.get(handle.id);
    const now = new Date().toISOString();
    if (!tracked) {
      return { healthy: false, detail: "not found", checkedAt: now };
    }
    const state = tracked.plugin.getState();
    const healthy = state === PluginState.Active;
    return {
      healthy,
      detail: healthy ? "active" : `state=${state}`,
      checkedAt: now,
    };
  }

  list(): PluginHandle[] {
    return [...this.handles.values()].map((t) => t.handle);
  }
}
