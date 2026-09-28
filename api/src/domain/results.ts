/** Versioned, officer-recorded outcome for one event session (P5.6b). */
import { z } from "zod";
import type { EventSession } from "./events.js";
import { ValidationError } from "./errors.js";
import { parsePlayerId } from "./identity.js";

export const OUTCOMES = ["win", "loss", "draw"] as const;
export type EventOutcome = (typeof OUTCOMES)[number];

export const RESULT_ROLES = ["starter", "substitute"] as const;
export type ResultRole = (typeof RESULT_ROLES)[number];

export type AllianceScorePrecision =
  | { kind: "exact" }
  | { kind: "rounded"; display: string; roundedTo: number };

/** One alliance's independent battle total. Never derived from player rows. */
export interface AllianceBattleScore {
  allianceTag: string;
  allianceName: string;
  isOurAlliance: boolean;
  score: number;
  precision: AllianceScorePrecision;
}

export interface PlayerPoints {
  playerId: string;
  points: number;
  role?: ResultRole;
  /** Omitted means exact; rounded sources retain their original display and precision. */
  precision?: AllianceScorePrecision;
}

export interface EventResult {
  eventId: string;
  sessionId: string;
  version: number;
  outcome: EventOutcome;
  ourScore: number;
  opponentScore: number;
  /** Present for multi-alliance battles such as Canyon Clash. */
  allianceScores?: AllianceBattleScore[];
  ourMatchmakingPower?: number;
  opponentMatchmakingPower?: number;
  opponentCombatants?: number;
  notes?: string;
  playerPoints: PlayerPoints[];
  recordedAt: string;
  recordedBy: string;
}

const optionalWhole = z.number().int().nonnegative().max(1_000_000_000_000).optional();
function roundedPrecisionMatches(score: number, precision: AllianceScorePrecision): boolean {
  if (precision.kind === "exact") return true;
  const match = /^(\d+)(?:\.(\d+))?([KMB])$/i.exec(precision.display);
  if (!match) return false;
  const factor = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[3]!.toUpperCase() as "K" | "M" | "B"];
  const decimals = match[2]?.length ?? 0;
  const represented = Math.round(Number(`${match[1]}.${match[2] ?? "0"}`) * factor);
  return score === represented && precision.roundedTo === factor / (10 ** decimals);
}
const scorePrecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact") }),
  z.object({
    kind: z.literal("rounded"),
    display: z.string().trim().regex(/^\d+(?:\.\d+)?[KMB]$/i, "Use a rounded display such as 515.0K."),
    roundedTo: z.number().int().positive().max(1_000_000_000),
  }),
]);
const allianceScoreSchema = z.object({
  allianceTag: z.string().trim().min(1).max(20),
  allianceName: z.string().trim().min(1).max(100),
  isOurAlliance: z.boolean(),
  score: z.number().int().nonnegative().max(1_000_000_000_000),
  precision: scorePrecisionSchema,
}).superRefine((row, ctx) => {
  if (!roundedPrecisionMatches(row.score, row.precision)) {
    ctx.addIssue({ code: "custom", message: "Rounded score, display and roundedTo must describe the same precision." });
  }
});
const ResultSchema = z.object({
  outcome: z.enum(OUTCOMES),
  ourScore: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  opponentScore: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  allianceScores: z.array(allianceScoreSchema).min(2).max(3).optional(),
  ourMatchmakingPower: optionalWhole,
  opponentMatchmakingPower: optionalWhole,
  opponentCombatants: z.number().int().min(0).max(100).optional(),
  notes: z.string().trim().max(2_000).optional(),
  playerPoints: z
    .array(
      z.object({
        playerId: z.union([z.string(), z.number()]).transform((value) => parsePlayerId(value)),
        points: z.number().int().nonnegative().max(1_000_000_000_000),
        role: z.enum(RESULT_ROLES).optional(),
        precision: scorePrecisionSchema.optional(),
      }).superRefine((row, ctx) => {
        if (row.precision && !roundedPrecisionMatches(row.points, row.precision)) {
          ctx.addIssue({ code: "custom", message: "Rounded player score, display and roundedTo must describe the same precision." });
        }
      }),
    )
    .max(200)
    .default([]),
  expectedVersion: z.number().int().min(0).optional(),
});

export function parseEventResult(
  input: unknown,
  session: EventSession,
  ctx: { eventId: string; eventKind?: string; recordedBy: string; now: Date; currentVersion: number },
): EventResult {
  const parsed = ResultSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid event result.", z.flattenError(parsed.error).fieldErrors);
  const {
    expectedVersion,
    notes,
    ourMatchmakingPower,
    opponentMatchmakingPower,
    opponentCombatants,
    allianceScores,
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
  if (!allianceScores && (value.ourScore === undefined || value.opponentScore === undefined)) {
    throw new ValidationError("ourScore and opponentScore are required for a two-team result.");
  }
  if (allianceScores) {
    if (ctx.eventKind && ctx.eventKind !== "canyon") {
      throw new ValidationError("Three-alliance totals are only supported for Canyon Clash results.");
    }
    if (allianceScores.length !== 3) throw new ValidationError("A Canyon Clash result must contain exactly three alliance totals.");
    if (new Set(allianceScores.map((row) => row.allianceTag.toUpperCase())).size !== allianceScores.length) {
      throw new ValidationError("Each alliance tag can appear only once.");
    }
    const ours = allianceScores.filter((row) => row.isOurAlliance);
    if (ours.length !== 1) throw new ValidationError("Exactly one alliance total must be marked as ours.");
    const highest = Math.max(...allianceScores.map((row) => row.score));
    const winners = allianceScores.filter((row) => row.score === highest);
    const derivedOutcome: EventOutcome = winners.length > 1 ? "draw" : winners[0]!.isOurAlliance ? "win" : "loss";
    if (value.outcome !== derivedOutcome) throw new ValidationError(`Outcome must be ${derivedOutcome} for the supplied alliance totals.`);
  }
  const ours = allianceScores?.find((row) => row.isOurAlliance);
  const bestOpponent = allianceScores?.filter((row) => !row.isOurAlliance).toSorted((a, b) => b.score - a.score)[0];
  const playerPoints: PlayerPoints[] = value.playerPoints.map((row) => ({
    playerId: row.playerId,
    points: row.points,
    ...(row.role ? { role: row.role } : {}),
    ...(row.precision ? { precision: row.precision } : {}),
  }));
  return {
    eventId: ctx.eventId,
    sessionId: session.id,
    version: ctx.currentVersion + 1,
    ...value,
    playerPoints,
    ...(allianceScores ? { allianceScores } : {}),
    // Keep the legacy pair populated so old readers remain safe. For Canyon these are a
    // compatibility projection only; allianceScores is the authoritative three-team metric.
    ourScore: ours?.score ?? value.ourScore!,
    opponentScore: bestOpponent?.score ?? value.opponentScore!,
    ...(ourMatchmakingPower !== undefined ? { ourMatchmakingPower } : {}),
    ...(opponentMatchmakingPower !== undefined ? { opponentMatchmakingPower } : {}),
    ...(opponentCombatants !== undefined ? { opponentCombatants } : {}),
    ...(notes ? { notes } : {}),
    recordedAt: ctx.now.toISOString(),
    recordedBy: ctx.recordedBy,
  };
}
