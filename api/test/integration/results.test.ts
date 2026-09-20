import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { parseNewEvent } from "../../src/domain/events.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const MEMBER = { as: "member", headers: { "x-account-id": "700000001" } };
const OTHER = { as: "other", headers: { "x-account-id": "700000002" } };

describe("event results", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    const actor = { id: "fixture", via: "seed" as const };
    await h.repo.createAccount(parseNewAccount({ playerId: "700000001", name: "Northstar" }), actor);
    await h.repo.createAccount(parseNewAccount({ playerId: "700000002", name: "Snowguard" }), actor);
    await h.repo.linkAccount("member", "700000001", actor);
    await h.repo.linkAccount("other", "700000002", actor);
    const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const event = parseNewEvent(
      { kind: "foundry", title: "Completed Foundry", startsAt, sessions: [{ id: "L1", label: "Legion 1", startsAt }] },
      { eventId: "RESULT-TEST", createdBy: "fixture", now: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    );
    await h.repo.createEvent(event, actor);
    eventId = event.eventId;
  });

  afterAll(() => h.cleanup());

  it("is officer-only and refuses unknown sessions and players", async () => {
    const body = { outcome: "win", ourScore: 10, opponentScore: 5, playerPoints: [] };
    expect((await h.call("POST", `/events/${eventId}/sessions/L1/result`, { ...MEMBER, body })).status).toBe(403);
    expect((await h.call("POST", `/events/${eventId}/sessions/L9/result`, { ...OFFICER, body })).status).toBe(404);
    const unknown = await h.call("POST", `/events/${eventId}/sessions/L1/result`, {
      ...OFFICER,
      body: { ...body, playerPoints: [{ playerId: "700000099", points: 1 }] },
    });
    expect(unknown.status).toBe(400);
  });

  it("records aggregates for everyone but exposes only the member's own points", async () => {
    const saved = await h.call("POST", `/events/${eventId}/sessions/L1/result`, {
      ...OFFICER,
      body: {
        outcome: "win",
        ourScore: 1_200,
        opponentScore: 900,
        ourMatchmakingPower: 123_000_000,
        opponentMatchmakingPower: 125_000_000,
        opponentCombatants: 27,
        notes: "Strong finish",
        playerPoints: [
          { playerId: "700000001", points: 42_000 },
          { playerId: "700000002", points: 39_000 },
        ],
      },
    });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ version: 1, outcome: "win" });

    const sessionFor = async (who: typeof OFFICER | typeof MEMBER | typeof OTHER) => {
      const detail = await h.call("GET", `/events/${eventId}`, who);
      return (detail.body.sessions as { id: string; result: Record<string, unknown> }[])[0]!.result;
    };
    expect(await sessionFor(MEMBER)).toMatchObject({ outcome: "win", playerPoints: [{ playerId: "700000001", name: "Northstar", points: 42_000 }] });
    expect(await sessionFor(OTHER)).toMatchObject({ playerPoints: [{ playerId: "700000002", name: "Snowguard", points: 39_000 }] });
    expect(((await sessionFor(OFFICER)).playerPoints as unknown[]).length).toBe(2);
  });

  it("version-checks corrections", async () => {
    const corrected = await h.call("POST", `/events/${eventId}/sessions/L1/result`, {
      ...OFFICER,
      body: { outcome: "draw", ourScore: 1_000, opponentScore: 1_000, playerPoints: [], expectedVersion: 1 },
    });
    expect(corrected.body).toMatchObject({ version: 2, outcome: "draw" });
    const stale = await h.call("POST", `/events/${eventId}/sessions/L1/result`, {
      ...OFFICER,
      body: { outcome: "loss", ourScore: 1, opponentScore: 2, playerPoints: [], expectedVersion: 1 },
    });
    expect(stale.status).toBe(400);
    expect(String(stale.body.title)).toMatch(/version 2/);
  });
});
