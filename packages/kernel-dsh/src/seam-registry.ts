/**
 * CordisSeamRegistry — bridges the `SeamRegistry` contract to Cordis's
 * service registry (`ctx.provide` / `ctx.get`).
 *
 * Mapping:
 *  - Each registered Provider is published as a Cordis service under the
 *    composite key `seam:<serviceId>@<version>`, and also indexed by
 *    provider name for fast lookup and unregister.
 *  - `resolve(ref)` picks the highest-version provider whose service id
 *    matches and whose version satisfies the consumer's range.
 *  - Registry events (registered/unregistered/rebound) are delivered to
 *    local subscribers; the adapter does not emit kernel-internal events.
 *
 * This is pure delegation: no business logic, only translation between
 * the Seam abstraction and Cordis primitives.
 */

import type { Context } from "@deepseek-ai/cordis";
import type {
  CapabilityId,
  CapabilityRef,
  PluginState,
  Result,
} from "@aigility-harness/core";
import type {
  Provider,
  SeamRegistry,
  SeamRegistryEvent,
  ServiceDefinition,
} from "@aigility-harness/core";
import { err, ok } from "@aigility-harness/core";
import { satisfies } from "./semver.js";

interface ProviderEntry {
  provider: Provider;
  service: ServiceDefinition;
  /** Cordis dispose function returned by `ctx.provide` */
  dispose: () => void;
}

export class CordisSeamRegistry implements SeamRegistry {
  /** provider name → entry */
  private readonly byName = new Map<string, ProviderEntry>();
  /** service id → provider names (insertion order) */
  private readonly byService = new Map<CapabilityId, string[]>();
  /** 故障转移绑定覆盖 (serviceId → pin 住的 provider 名) */
  private readonly preferred = new Map<CapabilityId, string>();
  private readonly listeners = new Set<(event: SeamRegistryEvent) => void>();

  constructor(private readonly ctx: Context) {}

  private serviceKey(service: ServiceDefinition): string {
    return `seam:${service.id}@${service.version}`;
  }

  async register<TReq, TRes>(
    service: ServiceDefinition<TReq, TRes>,
    provider: Provider<TReq, TRes>,
  ): Promise<Result<void>> {
    const name = provider.name;
    if (this.byName.has(name)) {
      return err(`provider already registered: ${name}`);
    }

    // Delegate to Cordis: publish the provider object as a service value.
    const key = this.serviceKey(service);
    const dispose = this.ctx.provide(key, provider);

    const entry: ProviderEntry = { provider, service, dispose };
    this.byName.set(name, entry);

    const list = this.byService.get(service.id) ?? [];
    list.push(name);
    this.byService.set(service.id, list);

    this.emitEvent({
      type: "registered",
      providerName: name,
      serviceId: service.id,
    });
    return ok(undefined);
  }

  async unregister(providerName: string): Promise<Result<void>> {
    const entry = this.byName.get(providerName);
    if (!entry) {
      return err(`provider not found: ${providerName}`);
    }

    // Dispose the Cordis service binding.
    entry.dispose();
    this.byName.delete(providerName);

    const list = this.byService.get(entry.service.id);
    if (list) {
      const idx = list.indexOf(providerName);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.byService.delete(entry.service.id);
    }

    this.emitEvent({
      type: "unregistered",
      providerName,
      serviceId: entry.service.id,
    });
    return ok(undefined);
  }

  async resolve<TReq, TRes>(
    ref: CapabilityRef,
  ): Promise<Result<Provider<TReq, TRes>>> {
    // 故障转移绑定优先 (scheduler.rebind pin 住的 provider); 不满足版本区间
    // 或不在册则回落默认选择
    const preferredName = this.preferred.get(ref.id);
    if (preferredName) {
      const entry = this.byName.get(preferredName);
      if (entry && entry.service.id === ref.id && satisfies(entry.service.version, ref.versionRange)) {
        return ok(entry.provider as Provider<TReq, TRes>);
      }
    }

    const best = this.pickDefault(ref);
    if (!best) {
      return err(`no provider satisfies ${ref.id}@${ref.versionRange}`);
    }
    return ok(best.provider as Provider<TReq, TRes>);
  }

  /** 默认选择: 满足版本区间的最高版本 provider (无覆盖时的绑定语义) */
  private pickDefault(ref: CapabilityRef): ProviderEntry | undefined {
    let best: ProviderEntry | undefined;
    for (const name of this.byService.get(ref.id) ?? []) {
      const entry = this.byName.get(name)!;
      if (!satisfies(entry.service.version, ref.versionRange)) continue;
      if (!best || compareVersions(entry.service.version, best.service.version) > 0) {
        best = entry;
      }
    }
    return best;
  }

  async rebind(
    ref: CapabilityRef,
    preferredProvider: string | null,
  ): Promise<Result<void>> {
    const from = this.preferred.get(ref.id) ?? this.pickDefault(ref)?.provider.name ?? "";
    if (preferredProvider === null) {
      this.preferred.delete(ref.id);
    } else {
      const entry = this.byName.get(preferredProvider);
      if (!entry || entry.service.id !== ref.id) {
        return err(`provider ${preferredProvider} not registered for ${ref.id}`);
      }
      this.preferred.set(ref.id, preferredProvider);
    }
    const to = preferredProvider ?? this.pickDefault(ref)?.provider.name ?? "";
    if (from !== to || preferredProvider === null) {
      this.emitEvent({
        type: "rebound",
        ref: { id: ref.id, versionRange: ref.versionRange },
        fromProvider: from,
        toProvider: to,
      });
    }
    return ok(undefined);
  }

  listProviders(id: CapabilityId): Provider[] {
    const names = this.byService.get(id) ?? [];
    return names.map((n) => this.byName.get(n)!.provider);
  }

  listAllServices(): Array<{ service: ServiceDefinition; providerName: string; state: PluginState }> {
    const out: Array<{ service: ServiceDefinition; providerName: string; state: PluginState }> = [];
    for (const entry of this.byName.values()) {
      out.push({ service: entry.service, providerName: entry.provider.name, state: entry.provider.state });
    }
    return out;
  }

  onEvent(callback: (event: SeamRegistryEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emitEvent(event: SeamRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors must not break registry operations
      }
    }
  }
}

/** Compare two semver strings; returns >0 / 0 / <0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
