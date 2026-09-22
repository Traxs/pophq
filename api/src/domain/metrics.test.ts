import { describe, expect, it } from "vitest";
import { allianceGrowth, buckets, seriesOf, valueAt, type AccountSeries } from "./metrics.js";
import type { Report } from "./measurements.js";

const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T12:00:00.000Z`;

describe("valueAt", () => {
  const points = [
    { at: day(1), value: 10 },
    { at: day(10), value: 30 },
    { at: day(5), value: 20 },
  ];
  it("takes the latest value at or before the moment", () => {
    expect(valueAt(points, day(4))).toBe(10);
    expect(valueAt(points, day(5))).toBe(20);
    expect(valueAt(points, day(30))).toBe(30);
  });
  it("is undefined before the first point", () => {
    expect(valueAt(points, "2026-08-01T00:00:00.000Z")).toBeUndefined();
    expect(valueAt([], day(5))).toBeUndefined();
  });
});

describe("buckets", () => {
  it("ends at now and steps back", () => {
    const ends = buckets(new Date(day(29)), 3, 7);
    expect(ends).toEqual([day(15), day(22), day(29)]);
  });
});

describe("allianceGrowth", () => {
  const series: AccountSeries[] = [
    { playerId: "1", name: "Grower", points: [{ at: day(1), value: 100 }, { at: day(20), value: 150 }] },
    { playerId: "2", name: "Flat", points: [{ at: day(1), value: 200 }, { at: day(20), value: 200 }] },
    { playerId: "3", name: "Joined late", points: [{ at: day(18), value: 50 }, { at: day(20), value: 60 }] },
    { playerId: "4", name: "Never reported", points: [] },
  ];
  const ends = [day(10), day(20)];
  const growth = allianceGrowth("city_power", series, ends);

  it("totals only members who had a value by each point", () => {
    expect(growth.points[0]).toEqual({ at: day(10), total: 300, average: 150, members: 2 });
    expect(growth.points[1]).toEqual({ at: day(20), total: 410, average: 137, members: 3 });
  });

  it("ranks growers by percent and keeps their numbers", () => {
    expect(growth.gainers.map((g) => g.name)).toEqual(["Grower", "Joined late"]); // 50% before 20%
    expect(growth.gainers.find((g) => g.name === "Grower")).toMatchObject({ from: 100, to: 150, change: 50, percent: 50 });
    // Someone who joined mid-window is measured from their own first value.
    expect(growth.gainers.find((g) => g.name === "Joined late")).toMatchObject({ from: 50, to: 60, percent: 20 });
  });

  it("lists members who did not grow, and those with no value at all", () => {
    expect(growth.stalled.map((s) => s.name)).toEqual(["Flat"]);
    expect(growth.missing).toEqual([{ playerId: "4", name: "Never reported" }]);
  });

  it("handles an alliance with no data at all", () => {
    const empty = allianceGrowth("city_power", [], ends);
    expect(empty.points).toEqual([
      { at: day(10), total: 0, average: 0, members: 0 },
      { at: day(20), total: 0, average: 0, members: 0 },
    ]);
    expect(empty.gainers).toEqual([]);
  });
});

describe("seriesOf", () => {
  const report = (id: string, at: string, value: number, supersedes?: string): Report => ({
    reportId: id,
    playerId: "1",
    effectiveAt: at,
    recordedAt: at,
    source: "player",
    values: [{ metric: "city_power", value, unit: "power", precision: "exact" }],
    ...(supersedes ? { supersedesReportId: supersedes } : {}),
  });

  it("drops corrected reports and sorts by effective time", () => {
    const points = seriesOf([report("a", day(2), 100), report("c", day(1), 90), report("b", day(3), 120, "a")], "city_power");
    expect(points).toEqual([
      { at: day(1), value: 90 },
      { at: day(3), value: 120 },
    ]);
  });

  it("ignores reports without that metric", () => {
    expect(seriesOf([report("a", day(1), 10)], "foundry_strength")).toEqual([]);
  });

  it("drops ignored reports", () => {
    const ignored = { ...report("b", day(2), 20), ignoredAt: day(3) };
    expect(seriesOf([report("a", day(1), 10), ignored], "city_power")).toEqual([{ at: day(1), value: 10 }]);
  });
});
