// Alliance events people sign up for: Foundry, Bear, SvS preparation and anything else an
// officer schedules (EVT-01..EVT-03). Answers belong to a game account, not to a login, so
// someone with alts answers once per account.
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const EVENT_KINDS = ["foundry", "bear", "svs", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ANSWERS = ["yes", "no", "maybe"] as const;
export type Answer = (typeof ANSWERS)[number];

/**
 * A part of an event people sign up for, such as a Foundry legion. Everyone picks at most one:
 * a player cannot be in Legion 1 and Legion 2 of the same battle.
 */
export interface EventSession {
  /** Short id used in answers, e.g. "L1". */
  id: string;
  label: string;
  startsAt: string;
  /** How many start; the rest who sign up are substitutes. Absent means no limit. */
  starters?: number;
  /** How many substitutes are taken along. */
  subs?: number;
}

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
  /** Empty for a plain event; two legions for Foundry. */
  sessions: EventSession[];
  createdBy: string;
}

export interface EventAnswer {
  eventId: string;
  playerId: string;
  answer: Answer;
  /** Which session they picked; only one, and only when the answer is "yes". */
  sessionId?: string;
  answeredAt: string;
  /** Who recorded it: the player themselves, or an officer acting for them. */
  source: "player" | "officer" | "import";
  note?: string;
}

const ISO = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use a date and time.")
  .transform((s) => new Date(s).toISOString());

const SessionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,8}$/, "Session id must be 1–8 letters, digits, - or _.")
    .optional(),
  label: z.string().trim().min(1, "Every session needs a name.").max(30),
  startsAt: ISO,
  starters: z.number().int().min(1).max(500).optional(),
  subs: z.number().int().min(0).max(500).optional(),
});

const ConfiguredSessionSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,8}$/, "Session id must be 1–8 letters, digits, - or _."),
  label: z.string().trim().min(1, "The session needs a name.").max(30),
});

const NewEventSchema = z.object({
  /** Parts people choose between, e.g. the two Foundry legions. At most one may be chosen. */
  sessions: z.array(SessionSchema).max(6, "At most six sessions.").optional(),
  /** Whole days before the start; the deadline then falls at the end of that day. */
  answersCloseDaysBefore: z.number().int().min(0).max(60).optional(),
  /** The officer's offset from UTC in minutes, so "end of the day" means their day. */
  timeZoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
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
  /** Guarded imports may faithfully record events that already happened. */
  allowPast?: boolean;
}

/**
 * How many days before the start answers close, per type. Foundry needs three days because
 * officers register the participants in game afterwards. An officer can override it per event,
 * and a settings screen will make these editable (P7.2).
 */
export const DEFAULT_LEAD_DAYS: Record<EventKind, number> = {
  foundry: 3,
  svs: 3,
  bear: 0,
  other: 0,
};

/** Without a lead time, answers close an hour before the start. */
const SAME_DAY_LEAD_MS = 60 * 60 * 1000;

/**
 * The deadline for a lead time of whole days: the end of that day, so people have all of it.
 * `endOfDayOffsetMinutes` is the reader's offset from UTC (the officer's time zone), because
 * "end of the 17th" means their evening, not UTC midnight.
 */
export function deadlineFor(startsAt: string, leadDays: number, endOfDayOffsetMinutes = 0): string {
  const start = Date.parse(startsAt);
  if (leadDays <= 0) return new Date(start - SAME_DAY_LEAD_MS).toISOString();
  const local = new Date(start - leadDays * 24 * 60 * 60 * 1000 + endOfDayOffsetMinutes * 60 * 1000);
  local.setUTCHours(23, 59, 59, 999);
  return new Date(local.getTime() - endOfDayOffsetMinutes * 60 * 1000).toISOString();
}

/** Events may be scheduled at most this far ahead, which catches year typos. */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export function parseNewEvent(input: unknown, ctx: NewEventContext): AllianceEvent {
  const parsed = NewEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid event.", z.flattenError(parsed.error).fieldErrors);
  }
  const { startsAt, deadlineAt, notes, answersCloseDaysBefore, timeZoneOffsetMinutes, sessions: rawSessions, ...rest } =
    parsed.data;
  const sessions = (rawSessions ?? []).map((session, index) => ({
    id: session.id ?? `S${index + 1}`,
    label: session.label,
    startsAt: session.startsAt,
    ...(session.starters === undefined ? {} : { starters: session.starters }),
    ...(session.subs === undefined ? {} : { subs: session.subs }),
  }));
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length) {
    throw new ValidationError("Each session needs its own id.");
  }
  // The event starts when its first session does, so reminders and lists use one moment.
  const startsAtEffective = sessions.length > 0 ? sessions.map((s) => s.startsAt).toSorted()[0]! : startsAt;
  const start = Date.parse(startsAtEffective);
  if (!ctx.allowPast && start <= ctx.now.getTime()) throw new ValidationError("The event must start in the future.");
  if (start > ctx.now.getTime() + MAX_AHEAD_MS) throw new ValidationError("The event is more than a year away.");

  const leadDays = answersCloseDaysBefore ?? DEFAULT_LEAD_DAYS[rest.kind];
  const deadline = deadlineAt ?? deadlineFor(startsAtEffective, leadDays, timeZoneOffsetMinutes ?? 0);
  if (Date.parse(deadline) > start) throw new ValidationError("Answers must close before the event starts.");
  // A deadline already in the past is allowed: an officer may add an event late, and it then
  // shows as closed rather than being refused.

  return {
    eventId: ctx.eventId,
    ...rest,
    startsAt: startsAtEffective,
    deadlineAt: deadline,
    ...(notes ? { notes } : {}),
    sessions,
    createdBy: ctx.createdBy,
  };
}

export interface AnswerChoice {
  answer: Answer;
  sessionId?: string;
}

/**
 * Reads an answer for an event: "yes" with a session when the event has sessions (a player
 * picks exactly one legion), plain yes/no/maybe otherwise. One answer per game account per
 * event, so choosing Legion 2 replaces Legion 1 rather than adding to it.
 */
export function parseAnswerChoice(event: Pick<AllianceEvent, "sessions">, input: unknown): AnswerChoice {
  const body = (input ?? {}) as { answer?: unknown; sessionId?: unknown };
  const answer = parseAnswer(body.answer);
  const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;

  if (event.sessions.length === 0) {
    if (sessionId) throw new ValidationError("This event has no parts to choose from.");
    return { answer };
  }
  if (answer === "yes") {
    if (!sessionId) throw new ValidationError(`Pick one: ${event.sessions.map((s) => s.label).join(" or ")}.`);
    if (!event.sessions.some((s) => s.id === sessionId)) throw new ValidationError("That part of the event doesn't exist.");
    return { answer, sessionId };
  }
  if (sessionId) throw new ValidationError("Only a yes can name a part of the event.");
  return { answer };
}

/**
 * Changes an officer may send. Written out rather than made from the create schema: that one
 * has defaults (kind "other"), and a partial version of it would quietly reset fields the
 * officer never mentioned.
 */
const EventChangesSchema = z.object({
  kind: z.enum(EVENT_KINDS).optional(),
  title: z.string().trim().min(3, "Title must be 3–60 characters.").max(60, "Title must be 3–60 characters.").optional(),
  startsAt: ISO.optional(),
  deadlineAt: ISO.optional(),
  notes: z.string().trim().max(2000).optional(),
  answersCloseDaysBefore: z.number().int().min(0).max(60).optional(),
  timeZoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
});

const AgentSessionSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,8}$/, "Session id must be 1–8 letters, digits, - or _."),
  label: z.string().trim().min(1, "Every session needs a name.").max(30),
  startsAt: ISO,
  starters: z.number().int().min(1).max(500).optional(),
  subs: z.number().int().min(0).max(500).optional(),
});

const AgentEventChangesSchema = EventChangesSchema.extend({
  sessions: z.array(AgentSessionSchema).max(6, "At most six sessions.").optional(),
});

const AgentEventIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/, "Event id must be 3–80 letters, digits, - or _.");

/** A bot-created event carries a stable caller-selected id so preview and retry refer to one target. */
export function parseAgentNewEvent(input: unknown, ctx: Omit<NewEventContext, "eventId" | "allowPast">): AllianceEvent {
  const eventId = AgentEventIdSchema.safeParse((input as { eventId?: unknown } | null)?.eventId);
  if (!eventId.success) throw new ValidationError("Invalid event id.");
  return parseNewEvent(input, { ...ctx, eventId: eventId.data, allowPast: true });
}

/**
 * Bots may maintain historical event metadata and parts. Existing part ids cannot disappear:
 * answers, lineups, strategies and results use them as durable foreign keys.
 */
export function parseAgentEventChanges(event: AllianceEvent, input: unknown, now: Date): AllianceEvent {
  const parsed = AgentEventChangesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid event change.", z.flattenError(parsed.error).fieldErrors);
  const changes = parsed.data;
  if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");

  const sessions: EventSession[] = changes.sessions
    ? changes.sessions.map((session) => ({
        id: session.id,
        label: session.label,
        startsAt: session.startsAt,
        ...(session.starters === undefined ? {} : { starters: session.starters }),
        ...(session.subs === undefined ? {} : { subs: session.subs }),
      }))
    : event.sessions;
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new ValidationError("Each session needs its own id.");
  }
  const incomingIds = new Set(sessions.map((session) => session.id));
  const removed = event.sessions.filter((session) => !incomingIds.has(session.id)).map((session) => session.id);
  if (removed.length > 0) {
    throw new ValidationError(`Existing session ids cannot be removed or renamed: ${removed.join(", ")}.`);
  }
  if (changes.startsAt && event.sessions.length > 0 && !changes.sessions) {
    throw new ValidationError("Change the session times; an event with parts starts at its earliest session.");
  }

  const startsAt = sessions.length > 0
    ? sessions.map((session) => session.startsAt).toSorted()[0]!
    : (changes.startsAt ?? event.startsAt);
  const kind = changes.kind ?? event.kind;
  const deadlineAt =
    changes.deadlineAt ??
    (startsAt !== event.startsAt || changes.answersCloseDaysBefore !== undefined || changes.kind
      ? deadlineFor(startsAt, changes.answersCloseDaysBefore ?? DEFAULT_LEAD_DAYS[kind], changes.timeZoneOffsetMinutes ?? 0)
      : event.deadlineAt);
  if (Date.parse(deadlineAt) > Date.parse(startsAt)) throw new ValidationError("Answers must close before the event starts.");
  if (Date.parse(startsAt) > now.getTime() + MAX_AHEAD_MS) throw new ValidationError("The event is more than a year away.");

  const updated: AllianceEvent = {
    ...event,
    kind,
    title: changes.title ?? event.title,
    startsAt,
    deadlineAt,
    sessions,
  };
  if (changes.notes !== undefined) {
    if (changes.notes) updated.notes = changes.notes;
    else delete updated.notes;
  }
  return updated;
}

/**
 * Applies an officer's changes to an existing event. Only the fields they sent change; the
 * result is validated exactly like a new event, so a change can't produce an impossible one.
 */
export function parseEventChanges(event: AllianceEvent, input: unknown, now: Date): AllianceEvent {
  const parsed = EventChangesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid change.", z.flattenError(parsed.error).fieldErrors);
  const changes = parsed.data;
  if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");

  const startsAt = changes.startsAt ?? event.startsAt;
  const kind = changes.kind ?? event.kind;
  // A new start without a new deadline moves the deadline with it, keeping the same lead time.
  const deadlineAt =
    changes.deadlineAt ??
    (changes.startsAt || changes.answersCloseDaysBefore !== undefined || changes.kind
      ? deadlineFor(startsAt, changes.answersCloseDaysBefore ?? DEFAULT_LEAD_DAYS[kind], changes.timeZoneOffsetMinutes ?? 0)
      : event.deadlineAt);

  const updated: AllianceEvent = {
    ...event,
    kind,
    title: changes.title ?? event.title,
    startsAt,
    deadlineAt,
    ...(changes.notes !== undefined ? { notes: changes.notes } : event.notes ? { notes: event.notes } : {}),
  };
  if (Date.parse(updated.deadlineAt) > Date.parse(updated.startsAt)) {
    throw new ValidationError("Answers must close before the event starts.");
  }
  if (Date.parse(updated.startsAt) > now.getTime() + MAX_AHEAD_MS) {
    throw new ValidationError("The event is more than a year away.");
  }
  return updated;
}

/**
 * Adds the one missing part to a legacy event. This is deliberately narrower than general event
 * editing: once an event has parts, changing their ids could orphan answers, lineups and results.
 */
export function configureLegacySession(event: AllianceEvent, input: unknown, now: Date): AllianceEvent {
  const parsed = ConfiguredSessionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid event part.", z.flattenError(parsed.error).fieldErrors);
  }
  const session = parsed.data;
  if (Date.parse(event.startsAt) > now.getTime() + MAX_AHEAD_MS) {
    throw new ValidationError("The event is more than a year away.");
  }
  if (Date.parse(event.deadlineAt) > Date.parse(event.startsAt)) {
    throw new ValidationError("Answers must close before the event starts.");
  }
  return {
    ...event,
    sessions: [
      {
        id: session.id,
        label: session.label,
        startsAt: event.startsAt,
        starters: 30,
        subs: 10,
      },
    ],
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
  /** Yes answers per session id, e.g. { L1: 19, L2: 30 }. */
  bySession: Record<string, number>;
}

/** Counts answers for an event; `expected` is how many accounts are asked to answer. */
export function countAnswers(answers: readonly EventAnswer[], expected: number): AnswerCounts {
  const counts = { yes: 0, no: 0, maybe: 0 };
  const bySession: Record<string, number> = {};
  for (const a of answers) {
    counts[a.answer] += 1;
    if (a.answer === "yes" && a.sessionId) bySession[a.sessionId] = (bySession[a.sessionId] ?? 0) + 1;
  }
  return { ...counts, pending: Math.max(0, expected - answers.length), bySession };
}

/**
 * How officers pick starters: strength first, reliability second (decision in docs/PLAN.md).
 * Attendance is the share of commitments actually kept; until attendance is tracked everyone
 * counts as fully reliable, so the ranking is strength alone and says so.
 */
export const STRENGTH_WEIGHT = 0.7;
export const ATTENDANCE_WEIGHT = 0.3;

export function lineupScore(strength: number | undefined, attendanceRate: number | undefined, strongest: number): number {
  const strengthShare = strongest > 0 ? (strength ?? 0) / strongest : 0;
  const attendance = attendanceRate ?? 1; // unknown reliability is not held against anyone
  return STRENGTH_WEIGHT * strengthShare + ATTENDANCE_WEIGHT * attendance;
}

export interface SessionStanding {
  sessionId: string;
  /** Position among the people signed up for this part, strongest first. */
  position: number;
  signedUp: number;
  /** "starter" or "sub" by the estimate; officers decide the real lineup (P5.4). */
  likely: "starter" | "sub";
  /** True while this is only an estimate, i.e. no lineup has been published yet. */
  estimate: true;
}

/**
 * Where someone stands in a part of an event, if officers picked by strength. Ranking is by the
 * given strength, strongest first; people without a known strength come last, earliest answer
 * first. It is an estimate and says so: officers pick the real lineup.
 */
export interface SignUp {
  playerId: string;
  strength?: number | undefined;
  /** Share of kept commitments, 0–1. Undefined until attendance is tracked. */
  attendanceRate?: number | undefined;
  answeredAt: string;
}

export interface RankedSignUp extends SignUp {
  position: number;
  score: number;
  likely: "starter" | "sub";
}

/**
 * Orders the people signed up for one part the way officers pick: by score, then by who
 * answered first. It is an estimate; officers publish the real lineup (P5.4).
 */
export function rankSignUps(entries: readonly SignUp[], starters: number | undefined): RankedSignUp[] {
  const strongest = Math.max(0, ...entries.map((e) => e.strength ?? 0));
  return [...entries]
    .map((entry) => ({ ...entry, score: lineupScore(entry.strength, entry.attendanceRate, strongest) }))
    .toSorted((a, b) => b.score - a.score || a.answeredAt.localeCompare(b.answeredAt))
    .map((entry, index) => ({
      ...entry,
      position: index + 1,
      likely: starters === undefined || index < starters ? ("starter" as const) : ("sub" as const),
    }));
}

export function standingFor(
  sessionId: string,
  entries: readonly SignUp[],
  playerId: string,
  starters: number | undefined,
): SessionStanding | undefined {
  const ranked = rankSignUps(entries, starters);
  const mine = ranked.find((e) => e.playerId === playerId);
  if (!mine) return undefined;
  return { sessionId, position: mine.position, signedUp: ranked.length, likely: mine.likely, estimate: true };
}
