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
});
