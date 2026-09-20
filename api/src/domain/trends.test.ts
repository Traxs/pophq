import { describe, expect, it } from "vitest";
import { monthlyAttendance, monthlyValues, monthsEnding } from "./trends.js";

const now = new Date("2026-09-20T12:00:00Z");

describe("monthsEnding", () => {
  it("lists whole months, oldest first, ending with this one", () => {
    expect(monthsEnding(now, 6)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  });
  it("crosses a year boundary", () => {
    expect(monthsEnding(new Date("2026-02-10T00:00:00Z"), 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("monthlyValues", () => {
  it("takes the last value of each month and carries it forward", () => {
    const points = [
      { at: "2026-05-04T00:00:00Z", value: 100 },
      { at: "2026-05-20T00:00:00Z", value: 120 }, // later in the same month wins
      { at: "2026-08-02T00:00:00Z", value: 150 },
    ];
    expect(monthlyValues(points, now, 6)).toEqual([null, 120, 120, 120, 150, 150]);
  });

  it("is all null when nothing was ever reported", () => {
    expect(monthlyValues([], now, 6)).toEqual([null, null, null, null, null, null]);
  });

  it("ignores values from after the window without losing earlier ones", () => {
    const points = [{ at: "2026-01-01T00:00:00Z", value: 10 }];
    expect(monthlyValues(points, now, 3)).toEqual([10, 10, 10]);
  });
});

describe("monthlyAttendance", () => {
  const record = (status: "present" | "absent" | "excused" | "unknown", month: string) => ({
    status,
    recordedAt: `${month}-15T12:00:00Z`,
  });

  it("is the share of kept commitments in each month", () => {
    const records = [
      record("present", "2026-08"),
      record("present", "2026-08"),
      record("absent", "2026-08"),
      record("absent", "2026-09"),
    ];
    const trend = monthlyAttendance(records, now, 6);
    expect(trend[4]).toBeCloseTo(2 / 3, 5); // August
    expect(trend[5]).toBe(0); // September
    expect(trend.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("leaves a month null when nothing was checked, and ignores excused records", () => {
    expect(monthlyAttendance([record("excused", "2026-09"), record("unknown", "2026-09")], now, 2)).toEqual([null, null]);
  });
});
