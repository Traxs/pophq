import { describe, expect, it } from "vitest";
import { parseAttendance, reliabilityOf, resolvedAttendance } from "./attendance.js";
import { ValidationError } from "./errors.js";

const record = (status: "present" | "absent" | "excused" | "unknown", day: number) => ({
  status,
  recordedAt: `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`,
});

describe("parseAttendance", () => {
  it("takes a status with its part and note", () => {
    expect(parseAttendance({ status: "present", sessionId: "L1", note: " late ", evidenceRef: "shot-1" })).toEqual({
      status: "present",
      sessionId: "L1",
      note: "late",
      evidenceRef: "shot-1",
    });
  });
  it.each([{}, { status: "maybe" }, { status: "" }, null])("rejects %j", (input) => {
    expect(() => parseAttendance(input)).toThrow(ValidationError);
  });
});

describe("reliabilityOf", () => {
  it("is the share of kept commitments", () => {
    const r = reliabilityOf([record("present", 1), record("present", 2), record("absent", 3)]);
    expect(r).toMatchObject({ kept: 2, missed: 1, sample: 3 });
    expect(r.rate).toBeCloseTo(2 / 3, 5);
  });

  it("never punishes someone for an excused absence or an unchecked event", () => {
    const r = reliabilityOf([record("present", 1), record("excused", 2), record("unknown", 3)]);
    expect(r).toMatchObject({ kept: 1, missed: 0, excused: 1, sample: 1 });
    expect(r.rate).toBe(1);
  });

  it("has no rate at all when nothing was ever checked", () => {
    expect(reliabilityOf([record("unknown", 1)]).rate).toBeUndefined();
    expect(reliabilityOf([]).rate).toBeUndefined();
  });

  it("looks only at the most recent events", () => {
    const old = Array.from({ length: 10 }, (_, i) => record("present", i + 1));
    const recent = Array.from({ length: 10 }, (_, i) => record("absent", i + 11));
    expect(reliabilityOf([...old, ...recent], 10).rate).toBe(0); // the last ten were all missed
    expect(reliabilityOf([...old, ...recent], 20).rate).toBe(0.5);
  });
});

describe("resolved attendance evidence", () => {
  it("uses a positive score as definitive attendance evidence", () => {
    expect(resolvedAttendance("absent", true, false)).toEqual({ status: "present", attendedByScore: true, evidence: "score" });
    expect(resolvedAttendance("excused", true, false)).toEqual({ status: "present", attendedByScore: true, evidence: "score" });
  });

  it("lets a reviewed status correct zero or missing score evidence", () => {
    expect(resolvedAttendance("present", false, true)).toEqual({ status: "present", attendedByScore: false, evidence: "record" });
    expect(resolvedAttendance("absent", false, false)).toEqual({ status: "absent", attendedByScore: false, evidence: "record" });
    expect(resolvedAttendance("excused", false, false)).toEqual({ status: "excused", attendedByScore: false, evidence: "record" });
  });

  it("uses score evidence when no reviewed attendance exists", () => {
    expect(resolvedAttendance(null, true, false)).toEqual({ status: "present", attendedByScore: true, evidence: "score" });
    expect(resolvedAttendance("unknown", false, true)).toEqual({ status: "absent", attendedByScore: false, evidence: null });
    expect(resolvedAttendance("unknown", false, false)).toEqual({ status: null, attendedByScore: false, evidence: null });
  });
});
