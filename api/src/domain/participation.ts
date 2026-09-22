/**
 * How much the alliance can count on somebody.
 *
 * Attendance alone was not enough. It only saw the events where an officer recorded who turned
 * up, so a member who never answers anything had no records at all — and no records meant no
 * rate, which the buff score read as "fully reliable". The most disengaged member scored the
 * same as the most dependable one.
 *
 * Each past event is now one of:
 *   - attended — they were there
 *   - no-show — they signed up and did not come, which cost the alliance a slot it had planned
 *     around, so it counts double
 *   - unregistered — they never answered, which is disengagement rather than a broken promise,
 *     so it counts half
 *   - excused, unchecked, or an honest "can't make it" — not counted at all
 */
import type { AttendanceRecord } from "./attendance.js";
import type { AllianceEvent, EventAnswer } from "./events.js";

export const OUTCOMES = ["attended", "no_show", "unregistered", "excused", "not_counted"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Attending earns full credit; the two failures cost what the alliance actually lost. */
export const OUTCOME_WEIGHT: Record<Outcome, number> = {
  attended: 1,
  no_show: 2,
  unregistered: 0.5,
  excused: 0,
  not_counted: 0,
};

const OUTCOME_VALUE: Record<Outcome, number> = {
  attended: 1,
  no_show: 0,
  unregistered: 0,
  excused: 0,
  not_counted: 0,
};

export function classify(answer: EventAnswer | undefined, attendance: AttendanceRecord | undefined): Outcome {
  if (attendance?.status === "excused") return "excused";
  if (attendance?.status === "present") return "attended";
  if (attendance?.status === "absent") {
    // Absent having promised to come is the expensive kind; absent having never signed up is
    // the same disengagement as saying nothing.
    return answer?.answer === "yes" ? "no_show" : "unregistered";
  }
  // Nobody recorded attendance. Saying "yes" or "can't make it" are both engagement, and a
  // missing screenshot must never count against either (FM: unknown is not absence).
  if (answer) return "not_counted";
  return "unregistered";
}

export interface ParticipationEvent {
  eventId: string;
  title: string;
  startsAt: string;
  outcome: Outcome;
}

export interface Participation {
  /** Weighted share, 0–1. Absent when nothing counted, which is not the same as zero. */
  rate?: number;
  attended: number;
  noShows: number;
  unregistered: number;
  excused: number;
  /** How many events actually counted towards the rate. */
  sample: number;
  /** The events behind the number, newest first. */
  events: ParticipationEvent[];
}

export interface ParticipationInput {
  events: readonly AllianceEvent[];
  answers: readonly EventAnswer[];
  attendance: readonly AttendanceRecord[];
  now: Date;
  /** How many recent events to weigh. */
  window?: number;
  /** When the account first appeared here; earlier events are not theirs to answer for. */
  knownSince?: string;
}

/**
 * The picture over the last `window` events that have started.
 *
 * An event from before the account was known counts only when there is evidence about it — an
 * answer or an attendance record. Otherwise it is skipped: an imported roster cannot be blamed
 * for staying silent about battles it predates, but the attendance imported alongside it is
 * real and still counts.
 */
export function participationOf({
  events,
  answers,
  attendance,
  now,
  window = 10,
  knownSince,
}: ParticipationInput): Participation {
  const answerFor = new Map(answers.map((a) => [a.eventId, a]));
  const attendanceFor = new Map(attendance.map((a) => [a.eventId, a]));

  const considered = events
    .filter((e) => Date.parse(e.startsAt) <= now.getTime())
    .filter(
      (e) =>
        !knownSince ||
        Date.parse(e.startsAt) >= Date.parse(knownSince) ||
        answerFor.has(e.eventId) ||
        attendanceFor.has(e.eventId),
    )
    .toSorted((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, window);

  const outcomes: ParticipationEvent[] = considered.map((event) => ({
    eventId: event.eventId,
    title: event.title,
    startsAt: event.startsAt,
    outcome: classify(answerFor.get(event.eventId), attendanceFor.get(event.eventId)),
  }));

  const count = (outcome: Outcome) => outcomes.filter((o) => o.outcome === outcome).length;
  const weight = outcomes.reduce((sum, o) => sum + OUTCOME_WEIGHT[o.outcome], 0);
  const value = outcomes.reduce((sum, o) => sum + OUTCOME_VALUE[o.outcome] * OUTCOME_WEIGHT[o.outcome], 0);

  return {
    ...(weight > 0 ? { rate: value / weight } : {}),
    attended: count("attended"),
    noShows: count("no_show"),
    unregistered: count("unregistered"),
    excused: count("excused"),
    sample: outcomes.filter((o) => OUTCOME_WEIGHT[o.outcome] > 0).length,
    events: outcomes,
  };
}
