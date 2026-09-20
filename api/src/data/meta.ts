import { ulid } from "ulid";

export type Via = "web" | `agent:${string}` | "jobs" | "migration" | "seed" | "admin";

/** Who changed something and how; stored on every item so the change history can attribute it. */
export interface Actor {
  /** Login sub, agent token id, or "system". */
  id: string;
  via: Via;
  reason?: string;
}

/** Audit fields every item carries (spec: Data model requirements). */
export function newItemMeta(actor: Actor, now: Date) {
  return {
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    updatedBy: actor.id,
    via: actor.via,
    changeId: ulid(now.getTime()),
    ...(actor.reason ? { reason: actor.reason } : {}),
  };
}
