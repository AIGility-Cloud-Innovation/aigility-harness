/**
 * EffectStore — shared internal storage for reversible side effects.
 *
 * Both `InMemoryEffectManager` (adapter-level rollback) and `DshSeamContext`
 * (per-invocation `addEffect`, which is synchronous) write to the same store
 * so that effect ids and rollback are consistent across the two surfaces.
 *
 * This is an internal implementation detail, not part of the public API.
 */

export interface StoredEffect {
  id: string;
  sessionId: string;
  description: string;
  rollback: () => Promise<void>;
}

export class EffectStore {
  private readonly byId = new Map<string, StoredEffect>();
  private readonly bySession = new Map<string, string[]>();
  private counter = 0;

  /** Synchronously record an effect and return its id. */
  record(
    sessionId: string,
    description: string,
    rollback: () => Promise<void>,
  ): string {
    const id = `effect-${++this.counter}`;
    const entry: StoredEffect = { id, sessionId, description, rollback };
    this.byId.set(id, entry);

    const list = this.bySession.get(sessionId) ?? [];
    list.push(id);
    this.bySession.set(sessionId, list);

    return id;
  }

  get(effectId: string): StoredEffect | undefined {
    return this.byId.get(effectId);
  }

  /** Roll back all effects for a session in reverse insertion order. */
  async rollbackAll(sessionId: string): Promise<string[]> {
    const list = this.bySession.get(sessionId);
    if (!list) return [];

    const errors: string[] = [];
    for (const id of [...list].reverse()) {
      const entry = this.byId.get(id);
      if (!entry) continue;
      try {
        await entry.rollback();
      } catch (e) {
        errors.push(String(e));
      }
      this.byId.delete(id);
    }
    this.bySession.delete(sessionId);
    return errors;
  }

  /** Roll back a single effect by id. */
  async rollbackOne(effectId: string): Promise<string | undefined> {
    const entry = this.byId.get(effectId);
    if (!entry) return `effect not found: ${effectId}`;

    try {
      await entry.rollback();
    } catch (e) {
      return String(e);
    }

    this.byId.delete(effectId);
    const list = this.bySession.get(entry.sessionId);
    if (list) {
      const idx = list.indexOf(effectId);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.bySession.delete(entry.sessionId);
    }
    return undefined;
  }

  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }
}
