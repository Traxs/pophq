// Picking buff times on a phone. The API stores slot numbers 0–47 from 00:00 UTC; people think
// in their own evening, so everything shown is local and only the round's dates stay UTC.
import type { BuffDayView, DayPreferenceInput } from "./api";
import { shortTime } from "./format";

export const SLOTS_PER_DAY = 48;
export const MAX_PREFERENCES_PER_DAY = 3;

/** The start of a slot in the reader's own time and locale, e.g. "20:30" or "8:30 PM". */
export function slotLabel(day: Pick<BuffDayView, "startsAt">, slot: number): string {
  return shortTime(new Date(Date.parse(day.startsAt) + slot * 30 * 60 * 1000).toISOString());
}

/** True when the slot falls on the next local day, which happens for anyone east of UTC. */
export function spillsOver(day: Pick<BuffDayView, "startsAt">, slot: number): boolean {
  const start = new Date(Date.parse(day.startsAt));
  const at = new Date(start.getTime() + slot * 30 * 60 * 1000);
  return at.getDate() !== start.getDate();
}

export interface DayDraft {
  dayId: string;
  /** Slot numbers in the order they were picked: first pick is the first choice. */
  slots: number[];
  anyTime: boolean;
  unavailable: boolean;
  note?: string;
}

export function emptyDraft(dayId: string): DayDraft {
  return { dayId, slots: [], anyTime: false, unavailable: false };
}

export function draftFrom(days: readonly BuffDayView[], saved: readonly DayPreferenceInput[] | null): DayDraft[] {
  return days.map((day) => {
    const mine = saved?.find((d) => d.dayId === day.id);
    if (!mine) return emptyDraft(day.id);
    return {
      dayId: day.id,
      slots: [...(mine.slots ?? [])],
      anyTime: Boolean(mine.anyTime),
      unavailable: Boolean(mine.unavailable),
      ...(mine.note ? { note: mine.note } : {}),
    };
  });
}

/**
 * Tapping a time picks it, tapping again drops it. The order of picks is the ranking, so the
 * first tap is the first choice. A fourth pick is ignored rather than silently replacing one.
 */
export function toggleSlot(draft: DayDraft, slot: number): DayDraft {
  if (draft.slots.includes(slot)) {
    return { ...draft, slots: draft.slots.filter((s) => s !== slot) };
  }
  if (draft.slots.length >= MAX_PREFERENCES_PER_DAY) return draft;
  // Picking a time means you can make that day after all.
  return { ...draft, slots: [...draft.slots, slot], anyTime: false, unavailable: false };
}

/** "Any time" and "not this day" are answers in themselves, so they clear the picked times. */
export function setAnyTime(draft: DayDraft, on: boolean): DayDraft {
  return on ? { ...draft, anyTime: true, unavailable: false, slots: [] } : { ...draft, anyTime: false };
}

export function setUnavailable(draft: DayDraft, on: boolean): DayDraft {
  return on ? { ...draft, unavailable: true, anyTime: false, slots: [] } : { ...draft, unavailable: false };
}

/** Where a slot sits in someone's wishes, 1-based, or undefined when it is not one of them. */
export function rankOf(draft: DayDraft, slot: number): number | undefined {
  const index = draft.slots.indexOf(slot);
  return index === -1 ? undefined : index + 1;
}

/** A day nobody has answered yet is left out, so "no answer" stays different from "any time". */
export function toPayload(drafts: readonly DayDraft[]): DayPreferenceInput[] {
  return drafts
    .filter((d) => d.slots.length > 0 || d.anyTime || d.unavailable)
    .map((d) => ({
      dayId: d.dayId,
      slots: d.slots,
      anyTime: d.anyTime,
      unavailable: d.unavailable,
      ...(d.note ? { note: d.note } : {}),
    }));
}

/** What a day's answer says in one line, for the card header. */
export function summarise(draft: DayDraft, day: Pick<BuffDayView, "startsAt">): string {
  if (draft.unavailable) return "Can't this day";
  if (draft.anyTime) return "Any time works";
  if (draft.slots.length === 0) return "No answer yet";
  return draft.slots.map((s) => slotLabel(day, s)).join(" · ");
}
