/**
 * InMemoryEffectManager — implements the `EffectManager` contract over a
 * shared `EffectStore`.
 *
 * Rollback semantics (per the KernelAdapter contract):
 *  - `record` stores the rollback function under a generated effect id,
 *    grouped by session id, preserving insertion order.
 *  - `rollbackAll(sessionId)` invokes every rollback for that session in
 *    **reverse insertion order**, then clears the session.
 *  - `rollbackOne(effectId)` invokes a single rollback and removes it.
 *
 * The store is shared with `DshSeamContext` so that synchronous
 * `addEffect` calls and adapter-level rollback share one id space.
 */

import type { Result } from "@aigility-arch/core";
import type { EffectManager } from "@aigility-arch/core";
import { err, ok } from "@aigility-arch/core";
import type { EffectStore } from "./effect-store.js";

export class InMemoryEffectManager implements EffectManager {
  constructor(private readonly store: EffectStore) {}

  async record(
    sessionId: string,
    description: string,
    rollback: () => Promise<void>,
  ): Promise<string> {
    return this.store.record(sessionId, description, rollback);
  }

  async rollbackAll(sessionId: string): Promise<Result<void>> {
    const errors = await this.store.rollbackAll(sessionId);
    return errors.length > 0 ? err(errors.join("; ")) : ok(undefined);
  }

  async rollbackOne(effectId: string): Promise<Result<void>> {
    const error = await this.store.rollbackOne(effectId);
    return error ? err(error) : ok(undefined);
  }
}
