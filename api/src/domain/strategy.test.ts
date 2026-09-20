import { describe, expect, it } from "vitest";
import type { EventSession } from "./events.js";
import { ValidationError } from "./errors.js";
import { parseStrategy } from "./strategy.js";

const session: EventSession = { id: "L1", label: "Legion 1", startsAt: "2026-09-27T12:00:00Z", starters: 30, subs: 10 };
const ctx = {
  eventId: "event-1",
  sessionId: "L1",
  publishedBy: "officer",
  now: new Date("2026-09-20T10:00:00Z"),
  currentVersion: 0,
};

describe("parseStrategy", () => {
  it("normalises assignments and publishes version one", () => {
    const strategy = parseStrategy(
      {
        body: "  **Hold both prototypes**\n\n- Rally together  ",
        assignments: [
          { playerId: 700000001, role: "Holder", duty: "  Prototype 1 ", note: "  Lead rallies " },
          { playerId: "700000002", role: "Looter", duty: "", note: "" },
        ],
      },
      session,
      ctx,
    );
    expect(strategy).toMatchObject({
      eventId: "event-1",
      sessionId: "L1",
      version: 1,
      body: "**Hold both prototypes**\n\n- Rally together",
      publishedAt: "2026-09-20T10:00:00.000Z",
      publishedBy: "officer",
      assignments: [
        { playerId: "700000001", role: "Holder", duty: "Prototype 1", note: "Lead rallies" },
        { playerId: "700000002", role: "Looter" },
      ],
    });
  });

  it("increments the version it replaces", () => {
    expect(parseStrategy({ body: "Plan", assignments: [], expectedVersion: 4 }, session, { ...ctx, currentVersion: 4 }).version).toBe(5);
  });

  it("uses the same clear stale-version rule as lineups", () => {
    expect(() => parseStrategy({ body: "Plan", assignments: [], expectedVersion: 2 }, session, { ...ctx, currentVersion: 3 })).toThrow(
      /someone published version 3 while you were editing/i,
    );
    expect(() => parseStrategy({ body: "Plan", assignments: [], expectedVersion: 1 }, session, ctx)).toThrow(
      /No strategy is published yet/,
    );
  });

  it("refuses duplicate people and unknown roles", () => {
    expect(() =>
      parseStrategy(
        {
          body: "Plan",
          assignments: [
            { playerId: "700000001", role: "Holder" },
            { playerId: "700000001", role: "Farmer" },
          ],
        },
        session,
        ctx,
      ),
    ).toThrow(/two strategy assignments/);
    expect(() => parseStrategy({ body: "Plan", assignments: [{ playerId: "700000001", role: "Wizard" }] }, session, ctx)).toThrow(
      ValidationError,
    );
  });
});
