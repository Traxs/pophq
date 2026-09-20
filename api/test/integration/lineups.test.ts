import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

const inDays = (days: number, hour = 19) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

interface SessionBody {
  id: string;
  lineup: {
    version: number;
    publishedAt: string;
    entries: { playerId: string; name: string; role: string; position: number; signedUp: boolean }[];
  } | null;
  yourPlace?: { role: string; position: number };
  yourStanding?: { likely: string };
}

describe("published lineups", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/events", {
      ...OFFICER,
      body: {
        kind: "foundry",
        title: "Foundry Saturday",
        startsAt: inDays(10),
        sessions: [
          { id: "L1", label: "Legion 1", startsAt: inDays(10, 12), starters: 2, subs: 1 },
          { id: "L2", label: "Legion 2", startsAt: inDays(10, 19), starters: 2, subs: 1 },
        ],
      },
    });
    expect(res.status).toBe(201);
    eventId = res.body.eventId as string;
    // Poppy signs up for Legion 1; the officer answers for two more accounts.
    await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "yes", sessionId: "L1" } });
    await h.call("PUT", `/events/${eventId}/answers/100000008`, { ...OFFICER, body: { answer: "yes", sessionId: "L1" } });
    await h.call("PUT", `/events/${eventId}/answers/100000010`, { ...OFFICER, body: { answer: "yes", sessionId: "L1" } });
  });
  afterAll(() => h.cleanup());

  const sessionOf = async (as: typeof PLAYER | typeof OFFICER, id = "L1") => {
    const res = await h.call("GET", `/events/${eventId}`, as);
    return (res.body.sessions as SessionBody[]).find((s) => s.id === id)!;
  };

  it("shows no lineup until officers publish one", async () => {
    const session = await sessionOf(PLAYER);
    expect(session.lineup).toBeNull();
    expect(session.yourPlace).toBeUndefined();
    expect(session.yourStanding?.likely).toBe("starter"); // still only the estimate
  });

  it("refuses to publish for anyone but an officer", async () => {
    const res = await h.call("POST", `/events/${eventId}/sessions/L1/lineup`, {
      ...PLAYER,
      body: { entries: [{ playerId: "100000001", role: "starter" }] },
    });
    expect(res.status).toBe(403);
  });

  it("publishes a lineup and tells every member where they stand", async () => {
    const res = await h.call("POST", `/events/${eventId}/sessions/L1/lineup`, {
      ...OFFICER,
      body: {
        entries: [
          { playerId: "100000008", role: "starter" },
          { playerId: "100000010", role: "starter" },
          { playerId: "100000001", role: "sub" },
        ],
        note: "Strongest two hold the gate",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 1, sessionId: "L1", eventId });

    const session = await sessionOf(PLAYER);
    expect(session.lineup).toMatchObject({ version: 1, note: "Strongest two hold the gate" });
    expect(session.lineup!.entries.map((e) => `${e.role}${e.position} ${e.name}`)).toEqual([
      "starter1 Aurora",
      "starter2 Polaris",
      "sub1 Poppy",
    ]);
    // Poppy is ranked first on strength but the officers chose otherwise; the published place wins.
    expect(session.yourPlace).toEqual({ role: "sub", position: 1 });
    expect(session.lineup!.entries.every((e) => e.signedUp)).toBe(true);
  });

  it("refuses a publish based on a version someone else replaced", async () => {
    const stale = await h.call("POST", `/events/${eventId}/sessions/L1/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "100000001", role: "starter" }], expectedVersion: 0 },
    });
    expect(stale.status).toBe(400);
    expect(String(stale.body.title)).toMatch(/version 1 while you were editing/);

    const fresh = await h.call("POST", `/events/${eventId}/sessions/L1/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "100000001", role: "starter" }], expectedVersion: 1 },
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.version).toBe(2);
  });

  it("enforces the session's capacity on the write", async () => {
    const res = await h.call("POST", `/events/${eventId}/sessions/L2/lineup`, {
      ...OFFICER,
      body: {
        entries: [
          { playerId: "100000001", role: "starter" },
          { playerId: "100000008", role: "starter" },
          { playerId: "100000010", role: "starter" },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.title)).toMatch(/takes 2 starters; you picked 3/);
  });

  it("refuses people who are not in the alliance, and unknown events or parts", async () => {
    const stranger = await h.call("POST", `/events/${eventId}/sessions/L2/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "999999999", role: "starter" }] },
    });
    expect(stranger.status).toBe(400);
    expect(String(stranger.body.title)).toMatch(/Not members of POP/);

    expect((await h.call("POST", `/events/${eventId}/sessions/L9/lineup`, { ...OFFICER, body: { entries: [] } })).status).toBe(404);
    expect((await h.call("POST", "/events/nope/sessions/L1/lineup", { ...OFFICER, body: { entries: [] } })).status).toBe(404);
  });

  it("marks someone an officer added who never answered", async () => {
    await h.call("POST", `/events/${eventId}/sessions/L2/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "100000002", role: "starter" }] },
    });
    const session = await sessionOf(OFFICER, "L2");
    expect(session.lineup!.entries[0]).toMatchObject({ playerId: "100000002", signedUp: false });
  });

  it("shows officers each member's place next to the numbers behind it", async () => {
    const res = await h.call("GET", `/events/${eventId}`, OFFICER);
    const members = res.body.members as { playerId: string; lineup: { sessionId: string; role: string } | null }[];
    expect(members.find((m) => m.playerId === "100000001")?.lineup).toMatchObject({ sessionId: "L1", role: "starter" });
    expect(members.find((m) => m.playerId === "100000005")?.lineup).toBeNull();
  });

  it("keeps every published version in the change history", async () => {
    const hist = await createHarness({ history: true });
    await seedDemo(hist.repo, new Date());
    const created = await hist.call("POST", "/events", {
      ...OFFICER,
      body: {
        kind: "foundry",
        title: "History check",
        startsAt: inDays(12),
        sessions: [{ id: "L1", label: "Legion 1", startsAt: inDays(12, 12), starters: 1, subs: 0 }],
      },
    });
    const id = created.body.eventId as string;
    await hist.call("POST", `/events/${id}/sessions/L1/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "100000001", role: "starter" }] },
    });
    await hist.call("POST", `/events/${id}/sessions/L1/lineup`, {
      ...OFFICER,
      body: { entries: [{ playerId: "100000008", role: "starter" }], expectedVersion: 1 },
    });
    const stored = await hist.repo.listLineups(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ version: 2, entries: [{ playerId: "100000008", role: "starter", position: 1 }] });
    await hist.cleanup();
  });
});
