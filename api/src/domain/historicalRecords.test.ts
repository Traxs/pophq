import { describe, expect, it } from "vitest";
import { parseHistoricalRecord } from "./historicalRecords.js";

describe("historical import records", () => {
  it("preserves typed source payloads without inventing product meaning", () => {
    expect(parseHistoricalRecord("alias-source-1", {
      category: "alias",
      sourceId: "row-1",
      playerId: "700000001",
      occurredAt: "2026-09-01T02:00:00+02:00",
      payload: { name: "Old Name", evidence: ["sheet-a"] },
    })).toEqual({
      recordId: "alias-source-1",
      category: "alias",
      sourceId: "row-1",
      playerId: "700000001",
      occurredAt: "2026-09-01T00:00:00.000Z",
      payload: { name: "Old Name", evidence: ["sheet-a"] },
    });
  });

  it("rejects unknown categories, invalid ids and oversized payloads", () => {
    expect(() => parseHistoricalRecord("ok-id", { category: "birthday", sourceId: "x", payload: {} })).toThrow(/Invalid historical/);
    expect(() => parseHistoricalRecord("?", { category: "alias", sourceId: "x", payload: {} })).toThrow(/record id/);
    expect(() => parseHistoricalRecord("large-record", { category: "evidence", sourceId: "x", payload: "x".repeat(100_001) })).toThrow(/too large/);
  });
});
