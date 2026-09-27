import type { EventDetail, SessionView } from "./api";

/**
 * Sessions can mean two different things:
 * - match parts with their own result (Foundry legions), or
 * - RSVP choices for a phase-scored event (SvS/KOI full time, first half, last half).
 *
 * Once a phase-scored event is over, empty RSVP choices are not historical result
 * records. Keep only sessions that contain an actual published record.
 */
export function visibleEventSessions(
  event: Pick<EventDetail, "sessions" | "scoreboards">,
  completed: boolean,
): SessionView[] {
  if (!completed || !event.scoreboards) return event.sessions;
  return event.sessions.filter((session) => Boolean(session.result || session.lineup || session.strategy));
}
