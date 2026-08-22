/**
 * DshSeamContext — per-invocation context implementing `SeamContext`.
 *
 * Delegates to the adapter's EffectStore (addEffect, synchronous), EventBus
 * (emit), and a session-scoped key-value store. Carries sessionId, traceId,
 * and callerLayer without exposing any kernel-specific globals.
 */

import type { LayerId, SystemEvent } from "@aigility-arch/core";
import type { SeamContext } from "@aigility-arch/core";
import type { EventBus } from "@aigility-arch/core";
import type { EffectStore } from "./effect-store.js";

export class DshSeamContext implements SeamContext {
  readonly sessionId: string;
  readonly traceId: string;
  readonly callerLayer: LayerId;

  private readonly store = new Map<string, unknown>();

  constructor(
    sessionId: string,
    callerLayer: LayerId,
    traceId: string,
    private readonly effects: EffectStore,
    private readonly events: EventBus,
  ) {
    this.sessionId = sessionId;
    this.callerLayer = callerLayer;
    this.traceId = traceId;
  }

  addEffect(description: string, rollback: () => Promise<void>): string {
    return this.effects.record(this.sessionId, description, rollback);
  }

  emit(event: Omit<SystemEvent, "seq" | "timestamp">): void {
    void this.events.publish({
      ...event,
      seq: 0,
      timestamp: new Date().toISOString(),
    });
  }

  getState<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  setState<T>(key: string, value: T): void {
    this.store.set(key, value);
  }
}
