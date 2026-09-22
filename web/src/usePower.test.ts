import { describe, expect, it } from "vitest";
import type { Report } from "./api";
import { toSeries } from "./powerReports";

const report = (reportId: string, power: number, extra: Partial<Report> = {}): Report => ({
  reportId,
  effectiveAt: `2026-09-${reportId === "A" ? "01" : "02"}T00:00:00.000Z`,
  recordedAt: `2026-09-${reportId === "A" ? "01" : "02"}T00:00:00.000Z`,
  source: "player",
  values: [{ metric: "city_power", value: power, unit: "power" }],
  ...extra,
});

describe("power history", () => {
  it("excludes ignored reports", () => {
    expect(toSeries([report("A", 100), report("B", 999, { ignoredAt: "2026-09-03T00:00:00.000Z" })])).toEqual([
      expect.objectContaining({ reportId: "A", power: 100 }),
    ]);
  });

  it("reactivates a predecessor when its correction is ignored", () => {
    expect(toSeries([
      report("A", 100),
      report("B", 999, { supersedesReportId: "A", ignoredAt: "2026-09-03T00:00:00.000Z" }),
    ])).toEqual([expect.objectContaining({ reportId: "A", power: 100 })]);
  });
});
