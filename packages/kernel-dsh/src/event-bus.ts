/**
 * CordisEventBus — bridges the `EventBus` contract to Cordis's event
 * mechanism (`ctx.on` / `ctx.emit`).
 *
 * Mapping:
 *  - Each published `SystemEvent` is emitted on the Cordis context under
 *    the event name `dsh:event:<layer>`, so layer-scoped subscriptions
 *    only receive their own layer's events.
 *  - The bus owns the monotonic `seq` and assigns `timestamp` on publish;
 *    any `seq`/`timestamp` on the incoming event are overwritten so that
 *    the event log is authoritative (event-sourcing semantics).
 *  - `replay` yields from the in-memory event log. In production this
 *    would bridge to NATS-JetStream; here it is local.
 *
 * Pure delegation: no business logic, only translation.
 */

import type { Context } from "@cordisjs/core";
import type { LayerId, SystemEvent } from "@aigility-arch/core";
import type { EventBus } from "@aigility-arch/core";

/**
 * Cordis types `ctx.on`/`ctx.emit` against `keyof Events<Context>` (the
 * internal event names). At runtime `EventsService` accepts any string.
 * This narrow interface lets us call the dynamic event API type-safely.
 */
interface DynamicEvents {
  on(name: string, listener: (...args: any[]) => any): () => void;
  emit(name: string, ...args: any[]): void;
}

export class CordisEventBus implements EventBus {
  private seq = 0;
  private readonly log: SystemEvent[] = [];
  private readonly events: DynamicEvents;

  constructor(ctx: Context) {
    this.events = ctx as unknown as DynamicEvents;
  }

  private eventName(layer: LayerId): string {
    return `dsh:event:${layer}`;
  }

  async publish(event: SystemEvent): Promise<void> {
    const full: SystemEvent = {
      ...event,
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
    };

    this.log.push(full);
    this.events.emit(this.eventName(full.layer), full);
  }

  subscribe(
    layer: LayerId,
    callback: (event: SystemEvent) => void,
  ): () => void {
    return this.events.on(this.eventName(layer), callback);
  }

  async *replay(fromSeq: number): AsyncIterable<SystemEvent> {
    for (const event of this.log) {
      if (event.seq >= fromSeq) {
        yield event;
      }
    }
  }
}
