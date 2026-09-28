import { describe, expect, it } from "vitest";
import { parseEventResult } from "./results.js";

const session = { id: "L1", label: "Legion 1", startsAt: "2026-09-20T12:00:00Z" };
const ctx = { eventId: "E1", recordedBy: "officer", now: new Date("2026-09-20T14:00:00Z"), currentVersion: 0 };

describe("parseEventResult", () => {
  it("normalises an omitted optional points list to empty", () => {
    expect(parseEventResult({ outcome: "draw", ourScore: 3, opponentScore: 3 }, session, ctx).playerPoints).toEqual([]);
  });

  it("normalises a complete first result", () => {
    expect(
      parseEventResult(
        {
          outcome: "win",
          ourScore: 1200,
          opponentScore: 900,
          ourMatchmakingPower: 123_000_000,
          opponentMatchmakingPower: 125_000_000,
          opponentCombatants: 27,
          notes: "  Strong finish  ",
          playerPoints: [{ playerId: 700000001, points: 42_000 }],
        },
        session,
        ctx,
      ),
    ).toMatchObject({ version: 1, notes: "Strong finish", playerPoints: [{ playerId: "700000001", points: 42_000 }] });
  });

  it("refuses duplicate players and stale edits", () => {
    expect(() =>
      parseEventResult(
        { outcome: "win", ourScore: 1, opponentScore: 0, playerPoints: [{ playerId: "700000001", points: 1 }, { playerId: "700000001", points: 2 }] },
        session,
        ctx,
      ),
    ).toThrow(/one points entry/);
    expect(() =>
      parseEventResult({ outcome: "loss", ourScore: 0, opponentScore: 1, playerPoints: [], expectedVersion: 1 }, session, ctx),
    ).toThrow(/No result is recorded/);
  });

  it("preserves three independent Canyon totals and explicit rounded precision", () => {
    const result = parseEventResult({
      outcome: "win",
      allianceScores: [
        { allianceTag: "POP", allianceName: "POP", isOurAlliance: true, score: 515_000, precision: { kind: "rounded", display: "515.0K", roundedTo: 100 } },
        { allianceTag: "BOS", allianceName: "S", isOurAlliance: false, score: 487_805, precision: { kind: "exact" } },
        { allianceTag: "SOA", allianceName: "SonsOfAnarchy", isOurAlliance: false, score: 486_816, precision: { kind: "exact" } },
      ],
      playerPoints: [
        { playerId: "700000001", points: 0, role: "substitute" },
        { playerId: "700000002", points: 515_000, precision: { kind: "rounded", display: "515.0K", roundedTo: 100 } },
      ],
    }, session, { ...ctx, eventKind: "canyon" });
    expect(result).toMatchObject({
      ourScore: 515_000,
      opponentScore: 487_805,
    });
    expect(result.playerPoints).toEqual([
      { playerId: "700000001", points: 0, role: "substitute" },
      { playerId: "700000002", points: 515_000, precision: { kind: "rounded", display: "515.0K", roundedTo: 100 } },
    ]);
    expect(result.allianceScores?.[0]).toMatchObject({ precision: { kind: "rounded", display: "515.0K", roundedTo: 100 } });
  });

  it("rejects a player rounded display that does not match its numeric representative", () => {
    expect(() => parseEventResult({
      outcome: "win",
      ourScore: 1,
      opponentScore: 0,
      playerPoints: [{ playerId: "700000001", points: 515_000, precision: { kind: "rounded", display: "516.0K", roundedTo: 100 } }],
    }, session, ctx)).toThrow(/Invalid event result/);
  });

  it("keeps legacy two-team results unchanged and rejects three-team totals outside Canyon", () => {
    expect(parseEventResult({ outcome: "loss", ourScore: 12, opponentScore: 13 }, session, { ...ctx, eventKind: "foundry" }))
      .toMatchObject({ ourScore: 12, opponentScore: 13, playerPoints: [] });
    expect(() => parseEventResult({
      outcome: "win",
      allianceScores: [
        { allianceTag: "POP", allianceName: "POP", isOurAlliance: true, score: 3, precision: { kind: "exact" } },
        { allianceTag: "A", allianceName: "A", isOurAlliance: false, score: 2, precision: { kind: "exact" } },
        { allianceTag: "B", allianceName: "B", isOurAlliance: false, score: 1, precision: { kind: "exact" } },
      ],
    }, session, { ...ctx, eventKind: "foundry" })).toThrow(/only supported for Canyon/);
  });
});
