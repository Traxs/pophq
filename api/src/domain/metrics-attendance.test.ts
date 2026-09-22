import { describe, expect, it } from "vitest";
import { allianceAttendance } from "./metrics.js";

const ends = ["2026-09-07T12:00:00.000Z", "2026-09-14T12:00:00.000Z", "2026-09-21T12:00:00.000Z"];

describe("allianceAttendance", () => {
  it("combines every checked member-event record in a week", () => {
    const points = allianceAttendance(
      [
        { eventId: "E1", at: "2026-09-02T12:00:00.000Z", present: 8, absent: 2 },
        { eventId: "E2", at: "2026-09-05T12:00:00.000Z", present: 1, absent: 1 },
      ],
      ends,
    );
    expect(points[0]).toMatchObject({ value: 75, events: 2, records: 12 });
  });

  it("carries the last observation through weeks without an event", () => {
    const points = allianceAttendance(
      [{ eventId: "E1", at: "2026-09-02T12:00:00.000Z", present: 3, absent: 1 }],
      ends,
    );
    expect(points.map((point) => point.value)).toEqual([75, 75, 75]);
    expect(points.map((point) => point.events)).toEqual([1, 0, 0]);
  });

  it("uses the latest earlier event as the opening baseline", () => {
    const points = allianceAttendance(
      [{ eventId: "OLD", at: "2026-08-01T12:00:00.000Z", present: 1, absent: 1 }],
      ends,
    );
    expect(points.map((point) => point.value)).toEqual([50, 50, 50]);
  });
});
