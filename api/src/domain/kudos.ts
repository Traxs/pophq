/**
 * Kudos: contributions the numbers cannot see (BUF-03 priority). An officer awards points with a
 * reason — helping a newcomer, donating, covering someone's buff slot — and recent kudos weigh
 * more than old ones, so the score says who is contributing now rather than who once did.
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

/** Points halve after this long, so a year-old favour counts for about a sixteenth. */
export const KUDOS_HALF_LIFE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * The decayed total at `now`. Negative awards subtract with the same decay, so taking points back
 * a year later does not wipe out what someone did last week.
 */
export function kudosScore(awards: readonly Pick<KudosAward, "points" | "awardedAt">[], now: Date): number {
  return awards.reduce((total, award) => {
    // An award dated in the future (clock skew, or an officer typing next week) counts at face
    // value rather than growing beyond it.
    const ageDays = Math.max(0, (now.getTime() - Date.parse(award.awardedAt)) / DAY_MS);
    return total + award.points * 0.5 ** (ageDays / KUDOS_HALF_LIFE_DAYS);
  }, 0);
}

/** Someone's share of the best kudos score in the alliance, 0–1. Nobody with kudos means 0 for all. */
export function kudosShare(score: number, best: number): number {
  if (best <= 0) return 0;
  return Math.max(0, Math.min(1, score / best));
}
