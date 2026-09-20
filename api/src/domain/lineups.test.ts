import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { rankSignUps, type EventSession } from "./events.js";
import { lineupCounts, parseLineup, placeIn, proposeLineup } from "./lineups.js";

const now = new Date("2026-09-20T10:00:00Z");
const session: EventSession = { id: "L1", label: "Legion 1", startsAt: "2026-09-27T12:00:00Z", starters: 3, subs: 1 };
const ctx = { eventId: "E1", sessionId: "L1", publishedBy: "officer-1", now, currentVersion: 0 };

describe("parseLineup", () => {
  it("numbers starters and substitutes in the order the officer sent them", () => {
    const lineup = parseLineup(
      {
        entries: [
          { playerId: "100000001", role: "starter" },
          { playerId: "100000002", role: "starter" },
          { playerId: "100000003", role: "sub" },
        ],
      },
      session,
      ctx,
    );
    expect(lineup.version).toBe(1);
    expect(lineup.entries).toEqual([
      { playerId: "100000001", role: "starter", position: 1 },
      { playerId: "100000002", role: "starter", position: 2 },
      { playerId: "100000003", role: "sub", position: 1 },
    ]);
    expect(lineup.publishedAt).toBe("2026-09-20T10:00:00.000Z");
  });

  it("increments the version of the lineup it replaces", () => {
    const lineup = parseLineup({ entries: [{ playerId: "100000001", role: "starter" }] }, session, {
      ...ctx,
      currentVersion: 4,
    });
    expect(lineup.version).toBe(5);
  });

  it("refuses more starters or substitutes than the session takes", () => {
    const four = ["100000001", "100000002", "100000003", "100000004"].map((playerId) => ({ playerId, role: "starter" }));
    expect(() => parseLineup({ entries: four }, session, ctx)).toThrow(/takes 3 starters; you picked 4/);
    expect(() =>
      parseLineup(
        { entries: [{ playerId: "100000001", role: "sub" }, { playerId: "100000002", role: "sub" }] },
        session,
        ctx,
      ),
    ).toThrow(/takes 1 substitutes; you picked 2/);
  });

  it("allows any number when the session has no capacity", () => {
    const open: EventSession = { id: "L1", label: "Everyone", startsAt: session.startsAt };
    const lineup = parseLineup(
      { entries: [{ playerId: "100000001", role: "starter" }, { playerId: "100000002", role: "starter" }] },
      open,
      ctx,
    );
    expect(lineupCounts(lineup)).toEqual({ starters: 2, subs: 0 });
  });

  it("refuses the same person twice", () => {
    expect(() =>
      parseLineup(
        { entries: [{ playerId: "100000001", role: "starter" }, { playerId: "100000001", role: "sub" }] },
        session,
        ctx,
      ),
    ).toThrow(ValidationError);
  });

  it("refuses a publish based on a version someone else already replaced", () => {
    expect(() =>
      parseLineup({ entries: [], expectedVersion: 2 }, session, { ...ctx, currentVersion: 3 }),
    ).toThrow(/published version 3 while you were editing/);
    expect(() => parseLineup({ entries: [], expectedVersion: 1 }, session, ctx)).toThrow(/No lineup is published yet/);
  });

  it("accepts a publish that names the version it saw", () => {
    expect(parseLineup({ entries: [], expectedVersion: 2 }, session, { ...ctx, currentVersion: 2 }).version).toBe(3);
  });

  it("keeps an empty lineup, which is how an officer withdraws one", () => {
    const lineup = parseLineup({ entries: [] }, session, ctx);
    expect(lineup.entries).toEqual([]);
    expect(placeIn(lineup, "100000001")).toBeUndefined();
  });

  it("rejects a bad player id or role", () => {
    expect(() => parseLineup({ entries: [{ playerId: "abc", role: "starter" }] }, session, ctx)).toThrow(ValidationError);
    expect(() => parseLineup({ entries: [{ playerId: "100000001", role: "captain" }] }, session, ctx)).toThrow(
      ValidationError,
    );
  });
});

describe("proposeLineup", () => {
  const signUps = [
    { playerId: "100000001", strength: 10_000_000, answeredAt: "2026-09-18T10:00:00Z" },
    { playerId: "100000002", strength: 9_000_000, answeredAt: "2026-09-18T11:00:00Z" },
    { playerId: "100000003", strength: 8_000_000, answeredAt: "2026-09-18T12:00:00Z" },
    { playerId: "100000004", strength: 7_000_000, answeredAt: "2026-09-18T13:00:00Z" },
    { playerId: "100000005", strength: 6_000_000, answeredAt: "2026-09-18T14:00:00Z" },
  ];

  it("cuts the ranking at the capacity: starters first, then substitutes", () => {
    const proposal = proposeLineup(rankSignUps(signUps, session.starters), session);
    expect(proposal).toEqual([
      { playerId: "100000001", role: "starter" },
      { playerId: "100000002", role: "starter" },
      { playerId: "100000003", role: "starter" },
      { playerId: "100000004", role: "sub" },
    ]);
  });

  it("takes everyone when the session has no capacity", () => {
    const proposal = proposeLineup(rankSignUps(signUps, undefined), {});
    expect(proposal).toHaveLength(5);
    expect(proposal.every((e) => e.role === "starter")).toBe(true);
  });

  it("produces something parseLineup accepts", () => {
    const proposal = proposeLineup(rankSignUps(signUps, session.starters), session);
    expect(parseLineup({ entries: proposal }, session, ctx).entries).toHaveLength(4);
  });
});
