/**
 * Published lineups (P5.4). Until officers publish one, the event page only shows an estimate
 * ranked by strength and attendance. A lineup turns that estimate into a decision: who starts,
 * who is a substitute, in which order. It is versioned, so two officers editing at the same
 * time cannot silently overwrite each other (FM-10), and every version is kept in the history
 * table like any other write.
 */
import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { EventSession, RankedSignUp } from "./events.js";
import { parsePlayerId } from "./identity.js";

export const LINEUP_ROLES = ["starter", "sub"] as const;
export type LineupRole = (typeof LINEUP_ROLES)[number];

export interface LineupEntry {
  playerId: string;
  role: LineupRole;
  /** Order within the role, 1-based: starter 1 is the first name on the list. */
  position: number;
}

export interface Lineup {
  eventId: string;
  sessionId: string;
  /** 1 for the first published lineup; every republish increments it. */
  version: number;
  entries: LineupEntry[];
  publishedAt: string;
  /** The officer's login sub. */
  publishedBy: string;
  note?: string;
}

/** An entry as an officer sends it: order comes from the array, not from a number they type. */
const EntrySchema = z.object({
  playerId: z.union([z.string(), z.number()]).transform((v) => parsePlayerId(v)),
  role: z.enum(LINEUP_ROLES),
});

const LineupSchema = z.object({
  entries: z.array(EntrySchema).max(200, "That is more people than any legion takes."),
  /** The version the officer edited, so a stale publish is refused rather than applied. */
  expectedVersion: z.number().int().min(0).optional(),
  note: z.string().trim().max(200).optional(),
});

export interface PublishContext {
  eventId: string;
  sessionId: string;
  publishedBy: string;
  now: Date;
  /** The version currently stored, 0 when nothing is published yet. */
  currentVersion: number;
}

/**
 * Reads a lineup an officer wants to publish and checks it against the session's capacity.
 * Capacity is enforced here and again in the write, because the session could be edited in
 * between (FM-10).
 */
export function parseLineup(input: unknown, session: EventSession, ctx: PublishContext): Lineup {
  const parsed = LineupSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid lineup.", z.flattenError(parsed.error).fieldErrors);
  const { entries, expectedVersion, note } = parsed.data;

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.playerId)) throw new ValidationError("Someone is in the lineup twice.");
    seen.add(entry.playerId);
  }

  if (expectedVersion !== undefined && expectedVersion !== ctx.currentVersion) {
    throw new ValidationError(
      ctx.currentVersion === 0
        ? "No lineup is published yet; reload the page before publishing."
        : `Someone published version ${ctx.currentVersion} while you were editing. Reload to see it.`,
    );
  }

  const starters = entries.filter((e) => e.role === "starter");
  const subs = entries.filter((e) => e.role === "sub");
  if (session.starters !== undefined && starters.length > session.starters) {
    throw new ValidationError(`${session.label} takes ${session.starters} starters; you picked ${starters.length}.`);
  }
  if (session.subs !== undefined && subs.length > session.subs) {
    throw new ValidationError(`${session.label} takes ${session.subs} substitutes; you picked ${subs.length}.`);
  }

  // Position follows the order the officer sent, per role.
  const positioned = [
    ...starters.map((e, i) => ({ ...e, position: i + 1 })),
    ...subs.map((e, i) => ({ ...e, position: i + 1 })),
  ];

  return {
    eventId: ctx.eventId,
    sessionId: ctx.sessionId,
    version: ctx.currentVersion + 1,
    entries: positioned,
    publishedAt: ctx.now.toISOString(),
    publishedBy: ctx.publishedBy,
    ...(note ? { note } : {}),
  };
}

/**
 * The starting point officers edit: the ranked sign-ups cut at the session's capacity. Without a
 * capacity everyone who signed up starts, which is what a session without limits means.
 */
export function proposeLineup(ranked: readonly RankedSignUp[], session: Pick<EventSession, "starters" | "subs">): Omit<LineupEntry, "position">[] {
  const limit = session.starters === undefined ? ranked.length : session.starters + (session.subs ?? 0);
  return ranked.slice(0, limit).map((entry) => ({
    playerId: entry.playerId,
    role: session.starters !== undefined && entry.position > session.starters ? ("sub" as const) : ("starter" as const),
  }));
}

/** Where someone stands in a published lineup, or undefined when they are not in it. */
export function placeIn(lineup: Lineup | undefined, playerId: string): LineupEntry | undefined {
  return lineup?.entries.find((e) => e.playerId === playerId);
}

/** How many starters and substitutes a published lineup holds. */
export function lineupCounts(lineup: Lineup): { starters: number; subs: number } {
  return {
    starters: lineup.entries.filter((e) => e.role === "starter").length,
    subs: lineup.entries.filter((e) => e.role === "sub").length,
  };
}
