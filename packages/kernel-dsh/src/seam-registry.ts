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

import type { Context } from "@cordisjs/core";
import type {
  CapabilityId,
  CapabilityRef,
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
    const names = this.byService.get(ref.id) ?? [];
    let best: { provider: Provider; version: string } | undefined;

    for (const name of names) {
      const entry = this.byName.get(name)!;
      if (!satisfies(entry.service.version, ref.versionRange)) continue;
      if (
        !best ||
        compareVersions(entry.service.version, best.version) > 0
      ) {
        best = { provider: entry.provider, version: entry.service.version };
      }
    }

    if (!best) {
      return err(`no provider satisfies ${ref.id}@${ref.versionRange}`);
    }
    return ok(best.provider as Provider<TReq, TRes>);
  }

  listProviders(id: CapabilityId): Provider[] {
    const names = this.byService.get(id) ?? [];
    return names.map((n) => this.byName.get(n)!.provider);
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
