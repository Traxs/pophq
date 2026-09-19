// Alliance events people sign up for: Foundry, Bear, SvS preparation and anything else an
// officer schedules (EVT-01..EVT-03). Answers belong to a game account, not to a login, so
// someone with alts answers once per account.
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const EVENT_KINDS = ["foundry", "bear", "svs", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ANSWERS = ["yes", "no", "maybe"] as const;
export type Answer = (typeof ANSWERS)[number];

export interface AllianceEvent {
  eventId: string;
  alliance: string;
  kind: EventKind;
  title: string;
  /** When the event starts, ISO 8601 in UTC. */
  startsAt: string;
  /** Answers are locked from this moment (FM-09). */
  deadlineAt: string;
  notes?: string;
  createdBy: string;
}

export interface EventAnswer {
  eventId: string;
  playerId: string;
  answer: Answer;
  answeredAt: string;
  /** Who recorded it: the player themselves, or an officer acting for them. */
  source: "player" | "officer";
  note?: string;
}

const ISO = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use a date and time.")
  .transform((s) => new Date(s).toISOString());

const NewEventSchema = z.object({
  kind: z.enum(EVENT_KINDS).default("other"),
  title: z.string().trim().min(3, "Title must be 3–60 characters.").max(60, "Title must be 3–60 characters."),
  startsAt: ISO,
  deadlineAt: ISO.optional(),
  notes: z.string().trim().max(2000).optional(),
  alliance: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,6}$/, "Alliance code must be 2–6 letters or digits.")
    .default("POP")
    .transform((s) => s.toUpperCase()),
});

export interface NewEventContext {
  eventId: string;
  createdBy: string;
  now: Date;
}

/** Default when an officer doesn't set one: answers close one hour before the start. */
export const DEFAULT_DEADLINE_LEAD_MS = 60 * 60 * 1000;

/** Events may be scheduled at most this far ahead, which catches year typos. */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export function parseNewEvent(input: unknown, ctx: NewEventContext): AllianceEvent {
  const parsed = NewEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid event.", z.flattenError(parsed.error).fieldErrors);
  }
  const { startsAt, deadlineAt, notes, ...rest } = parsed.data;
  const start = Date.parse(startsAt);
  if (start <= ctx.now.getTime()) throw new ValidationError("The event must start in the future.");
  if (start > ctx.now.getTime() + MAX_AHEAD_MS) throw new ValidationError("The event is more than a year away.");

  const deadline = deadlineAt ?? new Date(Math.max(start - DEFAULT_DEADLINE_LEAD_MS, ctx.now.getTime())).toISOString();
  if (Date.parse(deadline) > start) throw new ValidationError("Answers must close before the event starts.");
  if (Date.parse(deadline) <= ctx.now.getTime()) throw new ValidationError("The answer deadline is already past.");

  return {
    eventId: ctx.eventId,
    ...rest,
    startsAt,
    deadlineAt: deadline,
    ...(notes ? { notes } : {}),
    createdBy: ctx.createdBy,
  };
}

export function parseAnswer(raw: unknown): Answer {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const found = ANSWERS.find((a) => a === value);
  if (!found) throw new ValidationError(`Answer must be one of: ${ANSWERS.join(", ")}.`);
  return found;
}

export const isClosed = (event: Pick<AllianceEvent, "deadlineAt">, now: Date): boolean =>
  Date.parse(event.deadlineAt) <= now.getTime();

export interface AnswerCounts {
  yes: number;
  no: number;
  maybe: number;
  /** Active members and guests who have not answered yet. */
  pending: number;
}

/** Counts answers for an event; `expected` is how many accounts are asked to answer. */
export function countAnswers(answers: readonly EventAnswer[], expected: number): AnswerCounts {
  const counts = { yes: 0, no: 0, maybe: 0 };
  for (const a of answers) counts[a.answer] += 1;
  return { ...counts, pending: Math.max(0, expected - answers.length) };
}
