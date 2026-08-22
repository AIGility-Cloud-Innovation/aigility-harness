/**
 * LayerPlugin — the base interface every plugin across all five layers
 * must implement.
 *
 * A LayerPlugin is the unit of deployment.  It declares which layer it
 * belongs to, which capabilities it provides, and which it consumes.
 * The kernel uses this metadata for dependency resolution, ordering,
 * and carrier selection.
 */

import type {
  CarrierKind,
  LayerId,
  PluginState,
  Result,
} from "./types.js";
import type { CapabilityRef } from "./types.js";
import type {
  Provider,
  ServiceDefinition,
  SeamContext,
} from "./seam.js";

// ── Plugin Manifest ──────────────────────────────────────────────

/**
 * Static metadata declared by every plugin.  This is read at load time
 * before any code executes, enabling the kernel to plan deployment
 * without instantiating plugins.
 */
export interface PluginManifest {
  /** Unique plugin name, e.g. `@cognitive/llm-openai` */
  name: string;
  /** Which layer this plugin belongs to */
  layer: LayerId;
  /** Human-readable description */
  description: string;
  /** SemVer of this plugin */
  version: string;

  /** Capabilities this plugin provides */
  provides: ServiceDefinition[];

  /** Capabilities this plugin consumes */
  consumes: CapabilityRef[];

  /**
   * Preferred carrier for this plugin.
   * The scheduler may override this based on run mode and health.
   */
  preferredCarrier: CarrierKind;

  /**
   * Plugins that must be loaded before this one.
   * Used for topological sort at boot.
   */
  dependsOn?: string[];
}

// ── Layer Plugin ─────────────────────────────────────────────────

/**
 * The runtime interface for a layer plugin.
 *
 * `manifest` is static metadata; `onLoad` / `onUnload` are lifecycle
 * hooks; `getProviders` returns the live Provider instances.
 */
export interface LayerPlugin {
  readonly manifest: PluginManifest;

  /** Called once when the plugin is activated */
  onLoad(ctx: SeamContext): Promise<Result<void>>;

  /** Called when the plugin is being deactivated */
  onUnload?(): Promise<Result<void>>;

  /** Return provider instances for capabilities this plugin implements */
  getProviders(): Provider[];

  /** Current state, managed by the kernel */
  getState(): PluginState;
}

// ── Layer Descriptor ─────────────────────────────────────────────

/**
 * Describes a layer's configuration and constraints.
 * Used by the bootstrap system to validate the layer setup.
 */
export interface LayerDescriptor {
  id: LayerId;
  name: string;
  /** Layers that must be initialized before this one */
  dependsOn: LayerId[];
  /** Whether this layer is always-on (cannot be stopped independently) */
  alwaysOn: boolean;
  /** Default carrier for this layer in prototype mode */
  prototypeCarrier: CarrierKind;
  /** Default carrier for this layer in production mode */
  productionCarrier: CarrierKind;
}

// ── Standard Layer Descriptors ───────────────────────────────────

import { LayerId as L, CarrierKind as C } from "./types.js";

export const LAYER_DESCRIPTORS: Record<LayerId, LayerDescriptor> = {
  [L.Cognitive]: {
    id: L.Cognitive,
    name: "认知决策核心层",
    dependsOn: [L.Infrastructure],
    alwaysOn: true,
    prototypeCarrier: C.Thread,
    productionCarrier: C.NetworkService,
  },
  [L.Perception]: {
    id: L.Perception,
    name: "多模态感知交互层",
    dependsOn: [L.Infrastructure, L.Cognitive],
    alwaysOn: false,
    prototypeCarrier: C.Subprocess,
    productionCarrier: C.Daemon,
  },
  [L.Orchestration]: {
    id: L.Orchestration,
    name: "编排规划层",
    dependsOn: [L.Infrastructure, L.Cognitive],
    alwaysOn: false,
    prototypeCarrier: C.Thread,
    productionCarrier: C.NetworkService,
  },
  [L.Action]: {
    id: L.Action,
    name: "行动执行工具层",
    dependsOn: [L.Infrastructure, L.Orchestration],
    alwaysOn: false,
    prototypeCarrier: C.Subprocess,
    productionCarrier: C.Daemon,
  },
  [L.Infrastructure]: {
    id: L.Infrastructure,
    name: "底座兼容基础层",
    dependsOn: [],
    alwaysOn: true,
    prototypeCarrier: C.Thread,
    productionCarrier: C.NetworkService,
  },
};
