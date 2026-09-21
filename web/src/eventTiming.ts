// Timing helpers for the event form. Separate from the page so they can be tested without a browser.
import type { AllianceEvent } from "./api";

/** The deadline the API will compute, so the officer sees it before saving. */
export function previewDeadline(startsAt: Date, leadDays: number): Date {
  if (leadDays <= 0) return new Date(startsAt.getTime() - 60 * 60 * 1000);
  const day = new Date(startsAt.getTime() - leadDays * 24 * 60 * 60 * 1000);
  day.setHours(23, 59, 59, 999);
  return day;
}

/** "2026-09-20T19:00:00Z" as the value a datetime-local input expects, in local time. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/** How many whole days before the start an existing event closes; used to prefill the form. */
export function leadDaysOf(event: Pick<AllianceEvent, "startsAt" | "deadlineAt">): number {
  const gapMs = Date.parse(event.startsAt) - Date.parse(event.deadlineAt);
  return gapMs <= 2 * 60 * 60 * 1000 ? 0 : Math.max(0, Math.round(gapMs / (24 * 60 * 60 * 1000)));
}

/**
 * SvS and FDT run about six hours from 12:00 UTC, and members answer with how much of that they
 * can give. The three parts are derived from one start and a length rather than typed three
 * times: "Full time" and "First half" begin with the event, "Last half" at the midpoint.
 */
export const DEFAULT_EVENT_HOURS = 6;
export const HALF_IDS = ["full", "first", "last"] as const;

export function halvesFor(startLocalInput: string, hours: number): { id: string; label: string; startsAt: string }[] {
  const start = new Date(startLocalInput);
  if (!startLocalInput || Number.isNaN(start.getTime())) {
    return HALF_IDS.map((id, i) => ({ id, label: HALF_LABELS[i]!, startsAt: "" }));
  }
  const midpoint = new Date(start.getTime() + (hours / 2) * 60 * 60 * 1000);
  return [
    { id: "full", label: "Full time", startsAt: startLocalInput },
    { id: "first", label: "First half", startsAt: startLocalInput },
    { id: "last", label: "Last half", startsAt: localInputOf(midpoint) },
  ];
}

const HALF_LABELS = ["Full time", "First half", "Last half"];

/** A Date as the value a datetime-local input expects, in local time. */
export function localInputOf(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 16);
}

/**
 * The next 12:00 UTC that has not happened yet, as a local input value. SvS and FDT start there,
 * so an officer scheduling one only has to change the date.
 */
export function nextUtcNoon(now: Date = new Date()): string {
  const noon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0, 0));
  if (noon.getTime() <= now.getTime()) noon.setUTCDate(noon.getUTCDate() + 1);
  return localInputOf(noon);
}

/**
 * When an event's parts are the halves, the last half starts at the midpoint, so the end follows:
 * showing "12:00 – 18:00" beats "12:00 and 15:00", which reads like two separate sittings.
 */
export function halfSpan(
  sessions: readonly { id: string; startsAt: string }[],
): { startsAt: string; endsAt: string } | undefined {
  const ids = new Set(sessions.map((s) => s.id));
  if (!HALF_IDS.every((id) => ids.has(id))) return undefined;
  const start = Date.parse(sessions.find((s) => s.id === "full")!.startsAt);
  const midpoint = Date.parse(sessions.find((s) => s.id === "last")!.startsAt);
  if (Number.isNaN(start) || Number.isNaN(midpoint) || midpoint <= start) return undefined;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + 2 * (midpoint - start)).toISOString() };
}
