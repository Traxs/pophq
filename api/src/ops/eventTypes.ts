// Event types an alliance can edit (EVT-01). On first use the starter types are written, so
// officers have something to change instead of a blank page.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { STARTER_TYPES, type EventType } from "../domain/eventTypes.js";

export async function listEventTypes(repo: Repository, actor: Actor): Promise<EventType[]> {
  const stored = await repo.listEventTypes();
  if (stored.length > 0) return stored.toSorted((a, b) => a.name.localeCompare(b.name));
  for (const type of STARTER_TYPES) {
    await repo.putEventType({ ...type, createdBy: actor.id }, { ...actor, reason: "starter event types" });
  }
  return [...STARTER_TYPES].map((t) => ({ ...t, createdBy: actor.id }));
}
