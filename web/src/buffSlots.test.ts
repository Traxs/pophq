import { describe, expect, it } from "vitest";
import type { BuffDayView } from "./api";
import {
  draftFrom,
  emptyDraft,
  rankOf,
  setAnyTime,
  setUnavailable,
  summarise,
  toPayload,
  toggleSlot,
} from "./buffSlots";

const day = (over: Partial<BuffDayView> = {}): BuffDayView => ({
  id: "construction",
  buff: "construction",
  date: "2026-10-05",
  startsAt: "2026-10-05T00:00:00.000Z",
  endsAt: "2026-10-06T00:00:00.000Z",
  demand: Array.from({ length: 48 }, () => 0),
  anyTime: 0,
  unavailable: 0,
  ...over,
});

describe("toggleSlot", () => {
  it("picks in tap order, so the first tap is the first choice", () => {
    let d = emptyDraft("construction");
    d = toggleSlot(d, 40);
    d = toggleSlot(d, 20);
    expect(d.slots).toEqual([40, 20]);
    expect(rankOf(d, 40)).toBe(1);
    expect(rankOf(d, 20)).toBe(2);
    expect(rankOf(d, 3)).toBeUndefined();
  });

  it("tapping again drops the time and closes the gap in the ranking", () => {
    let d = { ...emptyDraft("construction"), slots: [40, 20, 10] };
    d = toggleSlot(d, 20);
    expect(d.slots).toEqual([40, 10]);
    expect(rankOf(d, 10)).toBe(2);
  });

  it("ignores a fourth pick rather than quietly replacing one", () => {
    const three = { ...emptyDraft("construction"), slots: [1, 2, 3] };
    expect(toggleSlot(three, 4)).toBe(three);
  });

  it("picking a time cancels 'any time' and 'can't this day'", () => {
    const d = toggleSlot({ ...emptyDraft("construction"), anyTime: true, unavailable: false }, 12);
    expect(d).toMatchObject({ slots: [12], anyTime: false, unavailable: false });
  });
});

describe("the two whole-day answers", () => {
  it("clear the picked times, and exclude each other", () => {
    const picked = { ...emptyDraft("construction"), slots: [1, 2] };
    expect(setAnyTime(picked, true)).toMatchObject({ anyTime: true, unavailable: false, slots: [] });
    expect(setUnavailable(picked, true)).toMatchObject({ unavailable: true, anyTime: false, slots: [] });
    expect(setUnavailable(setAnyTime(picked, true), true)).toMatchObject({ anyTime: false, unavailable: true });
  });

  it("can be turned off again", () => {
    expect(setAnyTime({ ...emptyDraft("c"), anyTime: true }, false).anyTime).toBe(false);
    expect(setUnavailable({ ...emptyDraft("c"), unavailable: true }, false).unavailable).toBe(false);
  });
});

describe("toPayload", () => {
  it("leaves out days nobody answered, so silence stays different from 'any time'", () => {
    const drafts = [
      { ...emptyDraft("construction"), slots: [5] },
      emptyDraft("research"),
      { ...emptyDraft("training"), anyTime: true },
    ];
    expect(toPayload(drafts).map((d) => d.dayId)).toEqual(["construction", "training"]);
  });

  it("keeps a note with the day it belongs to", () => {
    expect(toPayload([{ ...emptyDraft("training"), unavailable: true, note: "night shift" }])[0]).toMatchObject({
      dayId: "training",
      unavailable: true,
      note: "night shift",
    });
  });
});

describe("draftFrom", () => {
  it("starts from what was saved, and empty for a day never answered", () => {
    const drafts = draftFrom([day(), day({ id: "research", buff: "research" })], [
      { dayId: "construction", slots: [30, 31], anyTime: false, unavailable: false },
    ]);
    expect(drafts[0]).toMatchObject({ dayId: "construction", slots: [30, 31] });
    expect(drafts[1]).toEqual(emptyDraft("research"));
  });

  it("copies the saved slots rather than sharing them, so editing does not mutate the response", () => {
    const saved = [{ dayId: "construction", slots: [30] }];
    const drafts = draftFrom([day()], saved);
    toggleSlot(drafts[0]!, 31);
    expect(saved[0]!.slots).toEqual([30]);
  });

  it("treats no saved answer at all as a blank slate", () => {
    expect(draftFrom([day()], null)).toEqual([emptyDraft("construction")]);
  });
});

describe("summarise", () => {
  it("says what a day's answer means in one line", () => {
    expect(summarise(emptyDraft("c"), day())).toBe("No answer yet");
    expect(summarise({ ...emptyDraft("c"), anyTime: true }, day())).toBe("Any time works");
    expect(summarise({ ...emptyDraft("c"), unavailable: true }, day())).toBe("Can't this day");
    // Local times in the reader's own locale, so 24-hour and 12-hour clocks both pass here.
    expect(summarise({ ...emptyDraft("c"), slots: [0, 2] }, day())).toMatch(/^\d{1,2}:\d{2}( [AP]M)? · \d{1,2}:\d{2}( [AP]M)?$/);
  });
});
