import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "member", headers: { "x-account-id": "700000001" } };

const inDays = (days: number, hour = 19) => {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

interface SessionBody {
  id: string;
  strategy: {
    version: number;
    body: string;
    assignments: { playerId: string; name: string; role: string; duty?: string; note?: string }[];
  } | null;
  yourAssignment?: { role: string; duty?: string; note?: string };
}

describe("published strategies", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    const actor = { id: "fixture", via: "seed" as const };
    for (const input of [
      { playerId: "700000001", name: "Northstar" },
      { playerId: "700000002", name: "Snowguard" },
      { playerId: "700000003", name: "Icewing" },
    ]) {
      await h.repo.createAccount(parseNewAccount(input), actor);
    }
    await h.repo.linkAccount("member", "700000001", actor);
    const created = await h.call("POST", "/events", {
      ...OFFICER,
      body: {
        kind: "foundry",
        title: "Foundry strategy test",
        startsAt: inDays(10),
        sessions: [{ id: "L1", label: "Legion 1", startsAt: inDays(10, 12), starters: 2, subs: 1 }],
      },
    });
    eventId = created.body.eventId as string;
  });

  afterAll(() => h.cleanup());

  const sessionOf = async (who: typeof OFFICER | typeof PLAYER = OFFICER) => {
    const response = await h.call("GET", `/events/${eventId}`, who);
    return (response.body.sessions as SessionBody[]).find((session) => session.id === "L1")!;
  };

  it("starts with the event type's template and no published strategy", async () => {
    const response = await h.call("GET", `/events/${eventId}`, PLAYER);
    expect(response.status).toBe(200);
    expect(response.body.strategyTemplate).toContain("## Plan");
    expect((response.body.sessions as SessionBody[])[0]?.strategy).toBeNull();
  });

  it("keeps publication officer-only and requires assignments to be selected", async () => {
    expect(
      (
        await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
          ...PLAYER,
          body: { body: "Plan", assignments: [] },
        })
      ).status,
    ).toBe(403);

    const withoutLineup = await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
      ...OFFICER,
      body: { body: "Plan", assignments: [{ playerId: "700000001", role: "Holder" }] },
    });
    expect(withoutLineup.status).toBe(400);
    expect(String(withoutLineup.body.title)).toMatch(/Publish the lineup/);
  });

  it("publishes instructions and assignments for every member to read", async () => {
    expect(
      (
        await h.call("POST", `/events/${eventId}/sessions/L1/lineup`, {
          ...OFFICER,
          body: {
            entries: [
              { playerId: "700000001", role: "starter" },
              { playerId: "700000002", role: "starter" },
              { playerId: "700000003", role: "sub" },
            ],
          },
        })
      ).status,
    ).toBe(201);

    const published = await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
      ...OFFICER,
      body: {
        body: "**Opening**\n\n- Hold both prototypes",
        assignments: [
          { playerId: "700000001", role: "Holder", duty: "Prototype 1", note: "Lead rallies" },
          { playerId: "700000002", role: "Farmer", duty: "Weapon workshops" },
          { playerId: "700000003", role: "Substitute Looter" },
        ],
      },
    });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ version: 1, publishedBy: "officer" });

    const session = await sessionOf(PLAYER);
    expect(session.strategy).toMatchObject({
      version: 1,
      assignments: [
        { playerId: "700000001", name: "Northstar", role: "Holder", duty: "Prototype 1", note: "Lead rallies" },
        { playerId: "700000002", name: "Snowguard", role: "Farmer" },
        { playerId: "700000003", name: "Icewing", role: "Substitute Looter" },
      ],
    });
    expect(session.yourAssignment).toEqual({ role: "Holder", duty: "Prototype 1", note: "Lead rallies" });
  });

  it("refuses assignments outside the published lineup", async () => {
    const response = await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
      ...OFFICER,
      body: { body: "Plan", assignments: [{ playerId: "700000009", role: "Holder" }], expectedVersion: 1 },
    });
    expect(response.status).toBe(400);
    expect(String(response.body.title)).toMatch(/Not in the published Legion 1 lineup/);
  });

  it("rejects a stale editor and keeps the newer version", async () => {
    const fresh = await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
      ...OFFICER,
      body: { body: "Version two", assignments: [], expectedVersion: 1 },
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.version).toBe(2);

    const stale = await h.call("POST", `/events/${eventId}/sessions/L1/strategy`, {
      ...OFFICER,
      body: { body: "Stale", assignments: [], expectedVersion: 1 },
    });
    expect(stale.status).toBe(400);
    expect(String(stale.body.title)).toMatch(/someone published version 2 while you were editing/i);
    expect((await sessionOf()).strategy).toMatchObject({ version: 2, body: "Version two" });
  });
});
