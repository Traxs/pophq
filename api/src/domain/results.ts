/** Versioned, officer-recorded outcome for one event session (P5.6b). */
import { z } from "zod";
import type { EventSession } from "./events.js";
import { ValidationError } from "./errors.js";
import { parsePlayerId } from "./identity.js";

export const OUTCOMES = ["win", "loss", "draw"] as const;
export type EventOutcome = (typeof OUTCOMES)[number];

export interface PlayerPoints {
  playerId: string;
  points: number;
}

export interface EventResult {
  eventId: string;
  sessionId: string;
  version: number;
  outcome: EventOutcome;
  ourScore: number;
  opponentScore: number;
  ourMatchmakingPower?: number;
  opponentMatchmakingPower?: number;
  opponentCombatants?: number;
  notes?: string;
  playerPoints: PlayerPoints[];
  recordedAt: string;
  recordedBy: string;
}

const optionalWhole = z.number().int().nonnegative().max(1_000_000_000_000).optional();
const ResultSchema = z.object({
  outcome: z.enum(OUTCOMES),
  ourScore: z.number().int().nonnegative().max(1_000_000_000_000),
  opponentScore: z.number().int().nonnegative().max(1_000_000_000_000),
  ourMatchmakingPower: optionalWhole,
  opponentMatchmakingPower: optionalWhole,
  opponentCombatants: z.number().int().min(0).max(100).optional(),
  notes: z.string().trim().max(2_000).optional(),
  playerPoints: z
    .array(
      z.object({
        playerId: z.union([z.string(), z.number()]).transform((value) => parsePlayerId(value)),
        points: z.number().int().nonnegative().max(1_000_000_000_000),
      }),
    )
    .max(200)
    .default([]),
  expectedVersion: z.number().int().min(0).optional(),
});

export function parseEventResult(
  input: unknown,
  session: EventSession,
  ctx: { eventId: string; recordedBy: string; now: Date; currentVersion: number },
): EventResult {
  const parsed = ResultSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid event result.", z.flattenError(parsed.error).fieldErrors);
  const {
    expectedVersion,
    notes,
    ourMatchmakingPower,
    opponentMatchmakingPower,
    opponentCombatants,
    ...value
  } = parsed.data;
  if (expectedVersion !== undefined && expectedVersion !== ctx.currentVersion) {
    throw new ValidationError(
      ctx.currentVersion === 0
        ? "No result is recorded yet; reload the page before saving."
        : `Someone saved result version ${ctx.currentVersion} while you were editing. Reload to see it.`,
    );
  }
  if (new Set(value.playerPoints.map((row) => row.playerId)).size !== value.playerPoints.length) {
    throw new ValidationError("A player can only have one points entry.");
  }
  return {
    eventId: ctx.eventId,
    sessionId: session.id,
    version: ctx.currentVersion + 1,
    ...value,
    ...(ourMatchmakingPower !== undefined ? { ourMatchmakingPower } : {}),
    ...(opponentMatchmakingPower !== undefined ? { opponentMatchmakingPower } : {}),
    ...(opponentCombatants !== undefined ? { opponentCombatants } : {}),
    ...(notes ? { notes } : {}),
    recordedAt: ctx.now.toISOString(),
    recordedBy: ctx.recordedBy,
  };
}
