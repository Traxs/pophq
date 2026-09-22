import { describe, expect, it } from "vitest";
import { halfSpan, halvesFor, leadDaysOf, nextUtcNoon, previewDeadlineHours, toLocalInput } from "./eventTiming";

describe("leadDaysOf", () => {
  it("recognises a Foundry closing three days before", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-17T23:59:59.999Z" })).toBe(3);
  });
  it("recognises the one-hour case", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-20T11:00:00.000Z" })).toBe(0);
  });
  it("rounds a partial day to the nearest whole day", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-19T23:59:59.999Z" })).toBe(1);
  });
});

describe("previewDeadlineHours", () => {
  it("keeps SVS and KOI answers open until three hours before start", () => {
    expect(previewDeadlineHours(new Date("2026-09-20T12:00:00Z"), 3).toISOString()).toBe("2026-09-20T09:00:00.000Z");
  });
});

describe("halvesFor", () => {
  it("starts Full time and First half with the event, Last half halfway through", () => {
    const parts = halvesFor("2026-10-05T14:00", 6);
    expect(parts.map((p) => p.id)).toEqual(["full", "first", "last"]);
    expect(parts[0]!.startsAt).toBe("2026-10-05T14:00");
    expect(parts[1]!.startsAt).toBe("2026-10-05T14:00");
    expect(parts[2]!.startsAt).toBe("2026-10-05T17:00");
  });

  it("follows the length it is given", () => {
    expect(halvesFor("2026-10-05T14:00", 2)[2]!.startsAt).toBe("2026-10-05T15:00");
    expect(halvesFor("2026-10-05T14:00", 12)[2]!.startsAt).toBe("2026-10-05T20:00");
  });

  it("crosses midnight without losing the date", () => {
    expect(halvesFor("2026-10-05T22:00", 6)[2]!.startsAt).toBe("2026-10-06T01:00");
  });

  it("keeps the three parts, with empty times, before a start is chosen", () => {
    const parts = halvesFor("", 6);
    expect(parts.map((p) => p.label)).toEqual(["Full time", "First half", "Last half"]);
    expect(parts.every((p) => p.startsAt === "")).toBe(true);
    expect(halvesFor("not a date", 6).every((p) => p.startsAt === "")).toBe(true);
  });
});

describe("nextUtcNoon", () => {
  it("is today's 12:00 UTC while it is still ahead", () => {
    // 09:00 UTC, so noon has not happened yet.
    expect(nextUtcNoon(new Date("2026-10-05T09:00:00Z"))).toBe(toLocalInput("2026-10-05T12:00:00Z"));
  });

  it("rolls to tomorrow once today's has passed", () => {
    expect(nextUtcNoon(new Date("2026-10-05T12:00:00Z"))).toBe(toLocalInput("2026-10-06T12:00:00Z"));
    expect(nextUtcNoon(new Date("2026-10-05T23:30:00Z"))).toBe(toLocalInput("2026-10-06T12:00:00Z"));
  });
});

describe("halfSpan", () => {
  const halves = (full: string, last: string) => [
    { id: "full", startsAt: full },
    { id: "first", startsAt: full },
    { id: "last", startsAt: last },
  ];

  it("reads the length back out of the midpoint", () => {
    const span = halfSpan(halves("2026-10-05T12:00:00.000Z", "2026-10-05T15:00:00.000Z"));
    expect(span).toEqual({ startsAt: "2026-10-05T12:00:00.000Z", endsAt: "2026-10-05T18:00:00.000Z" });
  });

  it("is undefined for parts that are not the halves, like Foundry legions", () => {
    expect(
      halfSpan([
        { id: "L1", startsAt: "2026-10-05T12:00:00.000Z" },
        { id: "L2", startsAt: "2026-10-05T19:00:00.000Z" },
      ]),
    ).toBeUndefined();
  });

  it("gives up rather than inventing a span from nonsense", () => {
    expect(halfSpan(halves("2026-10-05T12:00:00.000Z", "2026-10-05T12:00:00.000Z"))).toBeUndefined();
    expect(halfSpan(halves("2026-10-05T12:00:00.000Z", "not a date"))).toBeUndefined();
  });
});
