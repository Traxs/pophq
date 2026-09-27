import { describe, expect, it } from "vitest";
import { parsePhaseScoreUpsert, phasesForEvent, scoreSubtotal, upsertPhaseScores } from "./eventScores.js";

describe("event phase scores", () => {
  it("configures preparation and castle battle independently", () => {
    expect(phasesForEvent("koi").map((phase) => phase.key)).toEqual(["preparation", "castle_battle"]);
    expect(phasesForEvent("foundry")).toEqual([]);
  });

  it("parses exact points and rejects duplicate players", () => {
    const input = parsePhaseScoreUpsert({ expectedVersion: 0, coverage: "partial", playerPoints: [{ playerId: "401250554", points: 91_473_892 }], source: { type: "owner_report", reference: "fixture.json" } });
    expect(input.playerPoints[0]).toEqual({ playerId: "401250554", points: 91_473_892 });
    expect(() => parsePhaseScoreUpsert({ ...input, playerPoints: [input.playerPoints[0], input.playerPoints[0]] })).toThrow(/once/i);
    for (const points of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parsePhaseScoreUpsert({ ...input, playerPoints: [{ playerId: "401250554", points }] })).toThrow(/invalid/i);
    }
    expect(() => parsePhaseScoreUpsert({ ...input, playerPoints: [{ playerId: "not-an-id", points: 1 }] })).toThrow();
  });

  it("upserts without deleting omitted players", () => {
    const context = { eventId: "E1", phaseKey: "castle_battle" as const, phaseLabel: "Castle battle phase", recordedAt: "2026-09-27T12:00:00Z", recordedBy: "bot" };
    const first = upsertPhaseScores(undefined, parsePhaseScoreUpsert({ expectedVersion: 0, coverage: "partial", playerPoints: [{ playerId: "401250554", points: 10 }], source: { type: "owner_report" } }), context);
    const second = upsertPhaseScores(first, parsePhaseScoreUpsert({ expectedVersion: 1, coverage: "partial", playerPoints: [{ playerId: "413494890", points: 20 }], source: { type: "owner_report" } }), context);
    expect(second).toMatchObject({ version: 2, playerPoints: [{ playerId: "413494890", points: 20 }, { playerId: "401250554", points: 10 }] });
    expect(scoreSubtotal(second.playerPoints)).toBe(30);
  });
});
