// Event types an alliance can edit (EVT-01). On first use the starter types are written, so
// officers have something to change instead of a blank page.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { STARTER_TYPES, type EventType } from "../domain/eventTypes.js";

/**
 * Every type an alliance has, with any starter type it is missing added on the way.
 *
 * Writing the starters only when the table was empty meant an alliance that started before a new
 * type existed never saw it. Adding by id is safe in both directions: a type an officer has
 * edited, renamed or archived already exists, so it is left exactly as they left it.
 */
export async function listEventTypes(repo: Repository, actor: Actor): Promise<EventType[]> {
  const stored = await repo.listEventTypes();
  const known = new Set(stored.map((t) => t.typeId));
  const missing = STARTER_TYPES.filter((t) => !known.has(t.typeId));
  for (const type of missing) {
    await repo.putEventType({ ...type, createdBy: actor.id }, { ...actor, reason: "starter event types" });
  }
  return [...stored, ...missing.map((t) => ({ ...t, createdBy: actor.id }))].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
}
