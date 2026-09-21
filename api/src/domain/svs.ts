/**
 * SvS buff slots (BUF-01..BUF-06). A round has three buff days — Construction, Research and
 * Training — each cut into 48 half-hour slots from 00:00 UTC. Members say when they could take a
 * buff; officers assign, because first-come gave the good hours to whoever refreshed fastest.
 *
 * Two caps, both enforced in the write rather than only here: one slot per person per buff day,
 * and at most two slots per person across the round, so the best hours reach more people.
 */
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const BUFFS = ["construction", "research", "training"] as const;
export type Buff = (typeof BUFFS)[number];

export const SLOTS_PER_DAY = 48;
export const SLOT_MINUTES = 30;
/** One slot per person per buff day, and no more than two across the round. */
export const MAX_SLOTS_PER_DAY = 1;
export const MAX_SLOTS_PER_ROUND = 2;
/** Up to three ranked wishes per day; beyond that the ranking stops meaning anything. */
export const MAX_PREFERENCES_PER_DAY = 3;

export interface BuffDay {
  /** Short id used in preferences and assignments, e.g. "construction". */
  id: string;
  buff: Buff;
  /** The calendar day in UTC, YYYY-MM-DD. Slot 0 starts at 00:00 UTC of this date. */
  date: string;
}

export interface SvsRound {
  roundId: string;
  alliance: string;
  label: string;
  days: BuffDay[];
  /** Preferences are read-only from this moment (FM-09). */
  preferenceDeadline: string;
  /** Set when officers publish the plan; absent while planning. */
  publishedAt?: string;
  createdBy: string;
}

/** Where a round is in its life, derived rather than stored so it can never get stuck. */
export type RoundState = "collecting" | "planning" | "published" | "closed";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function slotStartsAt(day: Pick<BuffDay, "date">, slot: number): string {
  return new Date(Date.parse(`${day.date}T00:00:00.000Z`) + slot * SLOT_MINUTES * 60 * 1000).toISOString();
}

/** The moment the last slot of a day ends, which is midnight at the end of that date. */
export function dayEndsAt(day: Pick<BuffDay, "date">): string {
  return new Date(Date.parse(`${day.date}T00:00:00.000Z`) + SLOTS_PER_DAY * SLOT_MINUTES * 60 * 1000).toISOString();
}

export function roundState(round: Pick<SvsRound, "days" | "preferenceDeadline" | "publishedAt">, now: Date): RoundState {
  const last = [...round.days].map((d) => dayEndsAt(d)).toSorted().at(-1);
  if (last && Date.parse(last) <= now.getTime()) return "closed";
  if (round.publishedAt) return "published";
  return Date.parse(round.preferenceDeadline) > now.getTime() ? "collecting" : "planning";
}

const DaySchema = z.object({
  buff: z.enum(BUFFS),
  date: z.string().trim().regex(ISO_DATE, "Use a date like 2026-10-05."),
});

const NewRoundSchema = z.object({
  label: z.string().trim().min(3, "Name the round, e.g. \"SvS week 40\".").max(60),
  /** The Monday of the SvS week; the three usual days are worked out from it. */
  weekStart: z.string().trim().regex(ISO_DATE, "Use a date like 2026-10-05.").optional(),
  /** Or spell the days out, for a state that does something unusual. */
  days: z.array(DaySchema).min(1, "A round needs at least one buff day.").max(7, "At most seven buff days.").optional(),
  preferenceDeadline: z
    .string()
    .trim()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Use a date and time.")
    .transform((s) => new Date(s).toISOString())
    .optional(),
  alliance: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,6}$/, "Alliance code must be 2–6 letters or digits.")
    .default("POP")
    .transform((s) => s.toUpperCase()),
});

/** Construction on Monday, Research on Tuesday, Training on Thursday: the usual SvS week. */
const DEFAULT_OFFSETS: { buff: Buff; daysAfterMonday: number }[] = [
  { buff: "construction", daysAfterMonday: 0 },
  { buff: "research", daysAfterMonday: 1 },
  { buff: "training", daysAfterMonday: 3 },
];

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function defaultDays(weekStart: string): BuffDay[] {
  return DEFAULT_OFFSETS.map(({ buff, daysAfterMonday }) => ({
    id: buff,
    buff,
    date: addDays(weekStart, daysAfterMonday),
  }));
}

/** Without an explicit deadline, preferences close at the end of the day before the first buff day. */
export function defaultDeadline(days: readonly BuffDay[]): string {
  const first = [...days].map((d) => d.date).toSorted()[0]!;
  return new Date(Date.parse(`${first}T00:00:00.000Z`) - 1).toISOString();
}

export function parseNewRound(input: unknown, ctx: { roundId: string; createdBy: string; now: Date }): SvsRound {
  const parsed = NewRoundSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid round.", z.flattenError(parsed.error).fieldErrors);
  const { label, weekStart, days: given, preferenceDeadline, alliance } = parsed.data;
  if (!weekStart && !given) throw new ValidationError("Give the SvS week's Monday, or the buff days themselves.");

  const days: BuffDay[] = given
    ? given.map((d, i) => ({ id: countOf(given, d.buff) > 1 ? `${d.buff}-${i + 1}` : d.buff, buff: d.buff, date: d.date }))
    : defaultDays(weekStart!);
  if (new Set(days.map((d) => d.id)).size !== days.length) throw new ValidationError("Each buff day needs its own id.");

  const deadline = preferenceDeadline ?? defaultDeadline(days);
  const firstStart = [...days].map((d) => `${d.date}T00:00:00.000Z`).toSorted()[0]!;
  if (Date.parse(deadline) > Date.parse(firstStart)) {
    throw new ValidationError("Preferences must close before the first buff day starts.");
  }
  const lastEnd = [...days].map((d) => dayEndsAt(d)).toSorted().at(-1)!;
  if (Date.parse(lastEnd) <= ctx.now.getTime()) throw new ValidationError("That round is already over.");

  return { roundId: ctx.roundId, alliance, label, days, preferenceDeadline: deadline, createdBy: ctx.createdBy };
}

const countOf = (days: readonly { buff: Buff }[], buff: Buff) => days.filter((d) => d.buff === buff).length;

export interface DayPreference {
  dayId: string;
  /** Slot numbers 0–47, best first. Empty when anyTime is set. */
  slots: number[];
  /** "Any time works" — better than three arbitrary picks when someone is flexible. */
  anyTime: boolean;
  /** "Not this day" — an explicit no, which is not the same as not answering. */
  unavailable: boolean;
  note?: string;
}

export interface SlotPreferences {
  roundId: string;
  playerId: string;
  days: DayPreference[];
  updatedAt: string;
}

const DayPreferenceSchema = z
  .object({
    dayId: z.string().trim().min(1),
    slots: z.array(z.number().int().min(0).max(SLOTS_PER_DAY - 1)).max(MAX_PREFERENCES_PER_DAY, `At most ${MAX_PREFERENCES_PER_DAY} times per day.`).optional(),
    anyTime: z.boolean().optional(),
    unavailable: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((d) => !(d.anyTime && d.unavailable), "Pick either any time or not this day, not both.")
  .refine((d) => !(d.unavailable && (d.slots?.length ?? 0) > 0), "Not available that day, but times were picked.");

const PreferencesSchema = z.object({
  days: z.array(DayPreferenceSchema).max(7),
});

export function parsePreferences(
  round: Pick<SvsRound, "roundId" | "days">,
  input: unknown,
  ctx: { playerId: string; now: Date },
): SlotPreferences {
  const parsed = PreferencesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid preferences.", z.flattenError(parsed.error).fieldErrors);
  const known = new Set(round.days.map((d) => d.id));
  const days: DayPreference[] = [];
  for (const day of parsed.data.days) {
    if (!known.has(day.dayId)) throw new ValidationError(`This round has no buff day "${day.dayId}".`);
    if (days.some((d) => d.dayId === day.dayId)) throw new ValidationError("One answer per buff day.");
    const slots = day.slots ?? [];
    if (new Set(slots).size !== slots.length) throw new ValidationError("The same time is picked twice.");
    days.push({
      dayId: day.dayId,
      slots,
      anyTime: day.anyTime ?? false,
      unavailable: day.unavailable ?? false,
      ...(day.note ? { note: day.note } : {}),
    });
  }
  return { roundId: round.roundId, playerId: ctx.playerId, days, updatedAt: ctx.now.toISOString() };
}

/**
 * How officers decide when more people want a slot than it holds. Attendance leads, because a buff
 * slot is a promise to be online at a time; strength keeps the valuable buffs on big accounts, and
 * kudos pays back the contributions no metric sees. Unknown attendance counts as reliable, exactly
 * as in the Foundry lineup, so missing data never costs someone their place.
 */
export const BUFF_ATTENDANCE_WEIGHT = 0.6;
export const BUFF_STRENGTH_WEIGHT = 0.2;
export const BUFF_KUDOS_WEIGHT = 0.2;

export function buffScore(input: {
  attendanceRate?: number | undefined;
  strength?: number | undefined;
  strongest: number;
  kudosShare?: number | undefined;
}): number {
  const attendance = input.attendanceRate ?? 1;
  const strengthShare = input.strongest > 0 ? Math.min(1, (input.strength ?? 0) / input.strongest) : 0;
  return (
    BUFF_ATTENDANCE_WEIGHT * attendance +
    BUFF_STRENGTH_WEIGHT * strengthShare +
    BUFF_KUDOS_WEIGHT * (input.kudosShare ?? 0)
  );
}

export interface Candidate {
  playerId: string;
  attendanceRate?: number | undefined;
  strength?: number | undefined;
  kudosShare?: number | undefined;
  /** Where this slot sits in their wishes: 1 is their first choice, undefined means not asked for. */
  rank?: number | undefined;
}

export interface RankedCandidate extends Candidate {
  score: number;
  position: number;
}

/**
 * Who should get a slot, best first. A first choice beats a second choice before the score is
 * consulted, so the ranking respects what people actually asked for; "any time" answers rank
 * behind anyone who named this slot.
 */
export function rankCandidates(candidates: readonly Candidate[], strongest: number): RankedCandidate[] {
  return [...candidates]
    .map((c) => ({ ...c, score: buffScore({ ...c, strongest }) }))
    .toSorted((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.score - a.score || a.playerId.localeCompare(b.playerId))
    .map((c, i) => ({ ...c, position: i + 1 }));
}
