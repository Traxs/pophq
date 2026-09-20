/**
 * Published strategies (P5.5): the instructions and role assignments for one event session.
 * A strategy is separate from the lineup: the lineup says who plays; the strategy says what
 * those people do. Republishing increments the version so concurrent officer edits cannot
 * silently overwrite each other, and DynamoDB Streams retain every version in history.
 */
import { z } from "zod";
import type { EventSession } from "./events.js";
import { ValidationError } from "./errors.js";
import { parsePlayerId } from "./identity.js";

export const STRATEGY_ROLES = ["Holder", "Looter", "Substitute Looter", "Farmer"] as const;
export type StrategyRole = (typeof STRATEGY_ROLES)[number];

export interface StrategyAssignment {
  playerId: string;
  role: StrategyRole;
  duty?: string;
  note?: string;
}

export interface Strategy {
  eventId: string;
  sessionId: string;
  /** 1 for the first publication; every republish increments it. */
  version: number;
  body: string;
  assignments: StrategyAssignment[];
  publishedAt: string;
  /** The publishing officer's login subject. */
  publishedBy: string;
}

const AssignmentSchema = z.object({
  playerId: z.union([z.string(), z.number()]).transform((value) => parsePlayerId(value)),
  role: z.enum(STRATEGY_ROLES),
  duty: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

const StrategySchema = z.object({
  body: z.string().trim().max(20_000),
  assignments: z.array(AssignmentSchema).max(200, "That is more assignments than an event part can use."),
  /** The version the officer edited; stale publications are refused. */
  expectedVersion: z.number().int().min(0).optional(),
});

export interface PublishStrategyContext {
  eventId: string;
  sessionId: string;
  publishedBy: string;
  now: Date;
  currentVersion: number;
}

export function parseStrategy(input: unknown, session: EventSession, ctx: PublishStrategyContext): Strategy {
  const parsed = StrategySchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid strategy.", z.flattenError(parsed.error).fieldErrors);
  const { body, assignments, expectedVersion } = parsed.data;

  if (expectedVersion !== undefined && expectedVersion !== ctx.currentVersion) {
    throw new ValidationError(
      ctx.currentVersion === 0
        ? "No strategy is published yet; reload the page before publishing."
        : `Someone published version ${ctx.currentVersion} while you were editing. Reload to see it.`,
    );
  }

  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.playerId)) throw new ValidationError("Someone has two strategy assignments.");
    seen.add(assignment.playerId);
  }

  return {
    eventId: ctx.eventId,
    sessionId: session.id,
    version: ctx.currentVersion + 1,
    body,
    assignments: assignments.map(({ duty, note, ...assignment }) => ({
      ...assignment,
      ...(duty ? { duty } : {}),
      ...(note ? { note } : {}),
    })),
    publishedAt: ctx.now.toISOString(),
    publishedBy: ctx.publishedBy,
  };
}
