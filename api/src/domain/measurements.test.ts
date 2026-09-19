import { describe, expect, it } from "vitest";
import { currentValues, parseReport, type Report, type ReportContext } from "./measurements.js";
import { ValidationError } from "./errors.js";

const now = new Date("2026-09-18T12:00:00Z");
const ctx = (over: Partial<ReportContext> = {}): ReportContext => ({
  playerId: "405338501",
  reportId: "01J0000000000000000000000A",
  source: "player",
  now,
  ...over,
});

describe("parseReport", () => {
  it("normalises values and stamps units and times", () => {
    const r = parseReport(
      {
        values: [
          { metric: "city_power", value: "45,123,456" },
          { metric: "furnace_level", value: "fc5-2" },
          { metric: "helios", value: "lancer" },
        ],
      },
      ctx(),
    );
    expect(r.effectiveAt).toBe(now.toISOString());
    expect(r.values).toEqual([
      { metric: "city_power", value: 45_123_456, unit: "power", precision: "exact" },
      { metric: "furnace_level", value: "FC5-2", unit: "level", precision: "exact" },
      { metric: "helios", value: "Lancer", unit: "type", precision: "exact" },
    ]);
  });

  // Same cases as the web form's check (web/src/rules.test.ts); keep both lists in step.
  const level = (value: string) => () => parseReport({ values: [{ metric: "furnace_level", value }] }, ctx());
  it.each(["1", "9", "25", "30", "FC1", "FC10", "FC5-2", "fc5-4", " FC3 "])("accepts level %j", (v) => {
    expect(level(v)).not.toThrow();
  });
  it.each(["", "0", "31", "FC", "FC0", "FC11", "FC99", "FC5-5", "FC5-0", "5-2", "abc"])("rejects level %j", (v) => {
    expect(level(v)).toThrow(ValidationError);
  });

  it("keeps Unknown, None and Soon distinct for Helios", () => {
    for (const v of ["Unknown", "None", "Soon"]) {
      expect(parseReport({ values: [{ metric: "helios", value: v }] }, ctx()).values[0]?.value).toBe(v);
    }
  });

  it("rejects unknown and duplicate metrics", () => {
    expect(() => parseReport({ values: [{ metric: "vibes", value: 1 }] }, ctx())).toThrow(/Unknown metric/);
    expect(() =>
      parseReport(
        {
          values: [
            { metric: "city_power", value: 1 },
            { metric: "city_power", value: 2 },
          ],
        },
        ctx(),
      ),
    ).toThrow(/appears twice/);
  });

  it("enforces ranges and integer-ness", () => {
    expect(() => parseReport({ values: [{ metric: "city_power", value: 2_000_000_001 }] }, ctx())).toThrow(
      ValidationError,
    );
    expect(() => parseReport({ values: [{ metric: "troops_lancer", value: 1.5 }] }, ctx())).toThrow(/whole number/);
    expect(parseReport({ values: [{ metric: "foundry_strength", value: 1234.56 }] }, ctx()).values[0]?.value).toBe(
      1234.56,
    );
  });

  it("refuses future dates beyond 5 minutes of clock tolerance", () => {
    const soon = new Date(now.getTime() + 4 * 60_000).toISOString();
    const later = new Date(now.getTime() + 6 * 60_000).toISOString();
    expect(() => parseReport({ effectiveAt: soon, values: [{ metric: "city_power", value: 1 }] }, ctx())).not.toThrow();
    expect(() => parseReport({ effectiveAt: later, values: [{ metric: "city_power", value: 1 }] }, ctx())).toThrow(
      /future/,
    );
  });

  it("limits backdating to 30 days for players but not for officers or imports", () => {
    const old = "2026-07-01T00:00:00Z";
    const input = { effectiveAt: old, values: [{ metric: "city_power", value: 1 }] };
    expect(() => parseReport(input, ctx())).toThrow(/30 days/);
    expect(parseReport(input, ctx({ source: "officer" })).effectiveAt).toBe("2026-07-01T00:00:00.000Z");
    expect(parseReport(input, ctx({ source: "import" })).effectiveAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("requires at least one value", () => {
    expect(() => parseReport({ values: [] }, ctx())).toThrow(ValidationError);
  });
});

describe("currentValues", () => {
  const rep = (id: string, effectiveAt: string, value: number, extra: Partial<Report> = {}): Report => ({
    reportId: id,
    playerId: "405338501",
    effectiveAt,
    recordedAt: effectiveAt,
    source: "player",
    values: [{ metric: "city_power", value, unit: "power", precision: "exact" }],
    ...extra,
  });

  it("takes the latest by effective date, not by submission order", () => {
    const cur = currentValues([
      rep("B", "2026-09-10T00:00:00.000Z", 200),
      rep("A", "2026-09-01T00:00:00.000Z", 100, { recordedAt: "2026-09-15T00:00:00.000Z" }),
    ]);
    expect(cur.city_power?.value).toBe(200);
  });

  it("ignores superseded reports", () => {
    const cur = currentValues([
      rep("A", "2026-09-10T00:00:00.000Z", 999),
      rep("B", "2026-09-09T00:00:00.000Z", 150, { supersedesReportId: "A" }),
    ]);
    expect(cur.city_power).toMatchObject({ value: 150, reportId: "B" });
  });

  it("breaks ties deterministically by report id", () => {
    const t = "2026-09-10T00:00:00.000Z";
    expect(currentValues([rep("B", t, 2), rep("A", t, 1)]).city_power?.value).toBe(2);
    expect(currentValues([rep("A", t, 1), rep("B", t, 2)]).city_power?.value).toBe(2);
  });
});
