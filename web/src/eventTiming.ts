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
