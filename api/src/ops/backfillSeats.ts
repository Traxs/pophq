// Gives a seat to every login that already has a game account (FM-08). Logins created before
// seats were counted don't hold one, so the cap would allow more than 100 people.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import type { Seats } from "../domain/seats.js";

export interface BackfillResult {
  logins: number;
  reserved: number;
  seats: Seats;
}

export async function backfillSeats(repo: Repository, actor: Actor, cap?: number): Promise<BackfillResult> {
  const logins = await repo.allLinkedLogins();
  let reserved = 0;
  for (const sub of logins) {
    if ((await repo.reserveSeat(sub, actor, cap)) === "reserved") reserved += 1;
  }
  return { logins: logins.length, reserved, seats: await repo.seats(cap) };
}
