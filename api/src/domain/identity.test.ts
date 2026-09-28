import { describe, expect, it } from "vitest";
import { membershipPeriods, parseGameName, parsePlayerId, searchKey, wasMemberAt, type IdentityAuditRecord } from "./identity.js";
import { ValidationError } from "./errors.js";

describe("parsePlayerId", () => {
  it.each(["405338501", "12345", 405338501])("accepts %s", (v) => {
    expect(parsePlayerId(v)).toBe(String(v));
  });

  it.each(["01234", "1234", "12a45", "", "1234567890123456", null])("rejects %s", (v) => {
    expect(() => parsePlayerId(v)).toThrow(ValidationError);
  });
});

describe("parseGameName", () => {
  it("keeps the raw spelling after NFKC normalisation", () => {
    expect(parseGameName("  IceQueen ")).toBe("IceQueen");
    expect(parseGameName("Ｐｏｐｐｙ")).toBe("Poppy"); // full-width letters
  });

  it.each([
    ["zero-width space", "Ice\u200bQueen"],
    ["bidi override", "Ice\u202eQueen"],
    ["Unicode tag characters", "Ice\u{e0041}Queen"],
    ["control character", "Ice\u0007Queen"],
  ])("rejects hidden %s", (_label, name) => {
    expect(() => parseGameName(name)).toThrow(/invisible or control/);
  });

  it("enforces 2–30 characters", () => {
    expect(() => parseGameName("A")).toThrow(ValidationError);
    expect(() => parseGameName("x".repeat(31))).toThrow(ValidationError);
    expect(parseGameName("x".repeat(30))).toHaveLength(30);
  });
});

describe("searchKey", () => {
  it("case-folds and collapses whitespace", () => {
    expect(searchKey("  Ice   QUEEN ")).toBe("ice queen");
  });
});

describe("membership periods", () => {
  const change = (action: "membership_left" | "membership_restored", performedAt: string, auditId: string): IdentityAuditRecord => ({
    auditId,
    action,
    subjectPlayerId: "10001",
    affectedPlayerIds: ["10001"],
    justification: "test membership change",
    performedAt,
    performedBy: "officer",
  });

  it("leaves the history of legacy accounts unrestricted", () => {
    const periods = membershipPeriods(["2026-01-01T00:00:00.000Z"], [], true);
    expect(periods).toEqual([]);
    expect(wasMemberAt(periods, "2025-01-01T00:00:00.000Z")).toBe(true);
  });

  it("closes the departure gap and opens a fresh period on return", () => {
    const periods = membershipPeriods([
      "2026-01-01T00:00:00.000Z",
    ], [
      change("membership_left", "2026-03-01T00:00:00.000Z", "left"),
      change("membership_restored", "2026-05-01T00:00:00.000Z", "back"),
    ], true);
    expect(periods).toEqual([
      { from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
      { from: "2026-05-01T00:00:00.000Z" },
    ]);
    expect(wasMemberAt(periods, "2026-02-01T00:00:00.000Z")).toBe(true);
    expect(wasMemberAt(periods, "2026-04-01T00:00:00.000Z")).toBe(false);
    expect(wasMemberAt(periods, "2026-06-01T00:00:00.000Z")).toBe(true);
  });

  it("uses the effective date and the latest immutable correction instead of the officer action time", () => {
    const left = { ...change("membership_left", "2026-04-10T12:00:00.000Z", "left"), effectiveAt: "2026-03-01T00:00:00.000Z" };
    const correction: IdentityAuditRecord = {
      ...change("membership_left", "2026-04-11T12:00:00.000Z", "correction"),
      action: "membership_date_corrected",
      targetAuditId: "left",
      effectiveAt: "2026-02-15T00:00:00.000Z",
      previousEffectiveAt: "2026-03-01T00:00:00.000Z",
    };
    expect(membershipPeriods(["2026-01-01T00:00:00.000Z"], [left, correction], false)).toEqual([
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-15T00:00:00.000Z" },
    ]);
  });
});
