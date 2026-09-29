import type { EventListItem } from "./api";
import { eventDayTime } from "./format";

type ShareableEvent = Pick<EventListItem, "eventId" | "title" | "startsAt" | "deadlineAt" | "sessions">;

export function eventSignupUrl(eventId: string, origin: string): string {
  return new URL(`/events/${encodeURIComponent(eventId)}`, origin).toString();
}

/** Short enough for game chat, while keeping every shared time explicitly in UTC. */
export function eventSignupMessage(event: ShareableEvent, origin: string): string {
  const schedule = event.sessions.length > 0
    ? event.sessions.map((session) => `${session.label}: ${eventDayTime(session.startsAt)}`).join("\n")
    : eventDayTime(event.startsAt);

  return [
    `Sign up for ${event.title}`,
    schedule,
    `Answers close: ${eventDayTime(event.deadlineAt)}`,
    "Choose your attendance in POP HQ:",
    eventSignupUrl(event.eventId, origin),
  ].join("\n");
}
