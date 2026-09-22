/**
 * Kudos: contributions the numbers cannot see (BUF-03 priority). An officer awards points with a
 * reason — helping a newcomer, donating, covering someone's buff slot — and recent kudos weigh
 * more than old ones, and an award stops counting after 90 days, so the score says who is
 * contributing now rather than who once did.
 *
 * Awards are immutable, like measurements: a mistake is corrected by awarding the opposite, which
 * keeps the change history honest about what an officer did and when.
 */
import { z } from "zod";
import { ValidationError } from "./errors.js";

export interface KudosAward {
  awardId: string;
  playerId: string;
  /** May be negative, which is how an officer takes points back. */
  points: number;
  reason: string;
  awardedAt: string;
  /** The officer's login sub. */
  awardedBy: string;
}

/** An award contributes nothing once it reaches this age. */
export const KUDOS_DECAY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface KudosContribution {
  /** This award's value at the requested moment, after decay. */
  currentPoints: number;
  /** 1 when new, falling evenly to 0 after 90 days. */
  remainingShare: number;
  ageDays: number;
  daysRemaining: number;
  expiresAt: string;
  active: boolean;
}

const AwardSchema = z.object({
  points: z
    .number()
    .int("Kudos are whole points.")
    .min(-50, "At most 50 points at a time.")
    .max(50, "At most 50 points at a time.")
    .refine((n) => n !== 0, "Zero points would say nothing."),
  reason: z.string().trim().min(3, "Say what the kudos is for.").max(200),
  awardedAt: z
    .string()
    .trim()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Use a date and time.")
    .transform((s) => new Date(s).toISOString())
    .optional(),
});

export function parseKudos(
  input: unknown,
  ctx: { awardId: string; playerId: string; awardedBy: string; now: Date },
): KudosAward {
  const parsed = AwardSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid kudos.", z.flattenError(parsed.error).fieldErrors);
  return {
    awardId: ctx.awardId,
    playerId: ctx.playerId,
    points: parsed.data.points,
    reason: parsed.data.reason,
    awardedAt: parsed.data.awardedAt ?? ctx.now.toISOString(),
    awardedBy: ctx.awardedBy,
  };
}

/**
 * The decayed total at `now`. Every award decreases linearly from full value to zero over 90 days.
 * Negative awards follow the same curve, so an old correction cannot wipe out recent work.
 */
export function kudosScore(awards: readonly Pick<KudosAward, "points" | "awardedAt">[], now: Date): number {
  return awards.reduce((total, award) => total + kudosContribution(award, now).currentPoints, 0);
}

/** The auditable calculation used by both the score and member-facing explanation. */
export function kudosContribution(
  award: Pick<KudosAward, "points" | "awardedAt">,
  now: Date,
): KudosContribution {
  // A future date (clock skew, or an officer typing next week) counts at face value rather than
  // growing beyond it. Its expiry still follows the recorded award date.
  const awardedAt = Date.parse(award.awardedAt);
  const ageDays = Math.max(0, (now.getTime() - awardedAt) / DAY_MS);
  const remainingShare = Math.max(0, 1 - ageDays / KUDOS_DECAY_DAYS);
  const expiresAt = new Date(awardedAt + KUDOS_DECAY_DAYS * DAY_MS).toISOString();
  return {
    // Avoid exposing JavaScript's surprising `-0` for an expired negative correction.
    currentPoints: remainingShare === 0 ? 0 : award.points * remainingShare,
    remainingShare,
    ageDays,
    daysRemaining: Math.max(0, Math.ceil(KUDOS_DECAY_DAYS - ageDays)),
    expiresAt,
    active: remainingShare > 0,
  };
}

/** Someone's share of the best kudos score in the alliance, 0–1. Nobody with kudos means 0 for all. */
export function kudosShare(score: number, best: number): number {
  if (best <= 0) return 0;
  return Math.max(0, Math.min(1, score / best));
}
