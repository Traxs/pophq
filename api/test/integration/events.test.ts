import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
// Seeded: the player login has two accounts (100000001 Poppy, 100000002 Goatzilla), so reads
// need an explicit account; the officer login has one and needs none.
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };
const ALT = { as: "player", headers: { "x-account-id": "100000002" } };

const inDays = (days: number, hour = 19) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe("events", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/events", {
      ...OFFICER,
      body: { kind: "foundry", title: "Foundry Saturday", startsAt: inDays(10), notes: "Bring traps" },
    });
    expect(res.status).toBe(201);
    eventId = res.body.eventId as string;
  });
  afterAll(() => h.cleanup());

  it("only lets officers create events, and validates them", async () => {
    expect((await h.call("POST", "/events", { ...PLAYER, body: { title: "Mine", startsAt: inDays(2) } })).status).toBe(403);
    expect((await h.call("POST", "/events", { ...OFFICER, body: { title: "No", startsAt: inDays(-2) } })).status).toBe(400);
    expect((await h.call("POST", "/events", { ...OFFICER, body: { title: "Hi", startsAt: inDays(2) } })).status).toBe(400);
  });

  it("shows upcoming events to everyone with their own answer", async () => {
    const list = await h.call("GET", "/events", PLAYER);
    expect(list.status).toBe(200);
    const items = list.body.items as { eventId: string; myAnswer: string | null; closed: boolean }[];
    const event = items.find((i) => i.eventId === eventId)!;
    expect(event).toMatchObject({ myAnswer: null, closed: false });

    const saved = await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "YES " } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ playerId: "100000001", answer: "yes", source: "player" });

    const after = await h.call("GET", "/events", PLAYER);
    expect((after.body.items as { eventId: string; myAnswer: string }[]).find((i) => i.eventId === eventId)?.myAnswer).toBe(
      "yes",
    );
  });

  it("keeps answers per game account, not per login", async () => {
    await h.call("PUT", `/events/${eventId}/answers/100000002`, { ...ALT, body: { answer: "no" } });
    const alt = await h.call("GET", "/events", ALT);
    const main = await h.call("GET", "/events", PLAYER);
    const answerOf = (res: { body: Record<string, unknown> }) =>
      (res.body.items as { eventId: string; myAnswer: string }[]).find((i) => i.eventId === eventId)?.myAnswer;
    expect(answerOf(alt)).toBe("no");
    expect(answerOf(main)).toBe("yes");
  });

  it("lets a player change their mind until the deadline", async () => {
    await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "maybe" } });
    const detail = await h.call("GET", `/events/${eventId}`, PLAYER);
    expect(detail.body.myAnswer).toBe("maybe");
  });

  it("refuses answers for accounts the player doesn't own", async () => {
    const res = await h.call("PUT", `/events/${eventId}/answers/100000008`, { ...PLAYER, body: { answer: "yes" } });
    expect(res.status).toBe(403);
  });

  it("lets officers answer for someone else, marked as an officer entry", async () => {
    const res = await h.call("PUT", `/events/${eventId}/answers/100000005`, { ...OFFICER, body: { answer: "yes" } });
    expect(res.body).toMatchObject({ source: "officer", playerId: "100000005" });
  });

  it("needs no account header when the login has just one account", async () => {
    const res = await h.call("GET", "/events", { as: "officer", groups: ["officer"] });
    const items = res.body.items as { eventId: string; myAnswer: string | null }[];
    expect(items.find((i) => i.eventId === eventId)).toBeDefined();
  });

  it("gives officers counts and the list of who has not answered", async () => {
    const detail = await h.call("GET", `/events/${eventId}`, OFFICER);
    // Poppy changed yes -> maybe, Goatzilla said no, an officer answered yes for 100000005.
    expect(detail.body.counts).toMatchObject({ yes: 1, no: 1, maybe: 1 });
    const members = detail.body.members as { playerId: string; answer: string | null }[];
    expect(members.length).toBeGreaterThan(30);
    const counts = detail.body.counts as { yes: number; no: number; maybe: number; pending: number };
    expect(members.filter((m) => m.answer === null).length).toBe(counts.pending);
    expect(members.filter((m) => m.answer !== null).length).toBe(counts.yes + counts.no + counts.maybe);

    const asPlayer = await h.call("GET", `/events/${eventId}`, PLAYER);
    expect(asPlayer.body.members).toBeUndefined();
    expect(asPlayer.body.counts).toMatchObject({ yes: 1 });
  });

  it("closes answers at the deadline (FM-09)", async () => {
    const soon = await h.call("POST", "/events", {
      ...OFFICER,
      body: { title: "Closing soon", startsAt: inDays(1), deadlineAt: new Date(Date.now() + 1500).toISOString() },
    });
    const id = soon.body.eventId as string;
    expect((await h.call("PUT", `/events/${id}/answers/100000001`, { ...PLAYER, body: { answer: "yes" } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1600));
    const late = await h.call("PUT", `/events/${id}/answers/100000001`, { ...PLAYER, body: { answer: "no" } });
    expect(late.status).toBe(409);
    expect(late.body.title).toContain("closed");
    const detail = await h.call("GET", `/events/${id}`, PLAYER);
    expect(detail.body.closed).toBe(true);
    expect(detail.body.myAnswer).toBe("yes"); // the answer given in time still stands
  });

  it("lets officers change an event, keeping the answers", async () => {
    const before = await h.call("GET", `/events/${eventId}`, OFFICER);
    const changed = await h.call("PATCH", `/events/${eventId}`, {
      ...OFFICER,
      body: { title: "Foundry Saturday (moved)", startsAt: inDays(5), notes: "New time" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ title: "Foundry Saturday (moved)", notes: "New time" });
    // The deadline moves with the start, keeping the Foundry lead time of three days.
    const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
    expect(days(changed.body.startsAt as string, changed.body.deadlineAt as string)).toBe(3);

    const after = await h.call("GET", `/events/${eventId}`, OFFICER);
    expect(after.body.counts).toEqual(before.body.counts);
  });

  it("refuses changes from players, impossible changes and unknown events", async () => {
    expect((await h.call("PATCH", `/events/${eventId}`, { ...PLAYER, body: { title: "Mine now" } })).status).toBe(403);
    expect((await h.call("PATCH", `/events/${eventId}`, { ...OFFICER, body: {} })).status).toBe(400);
    expect(
      (await h.call("PATCH", `/events/${eventId}`, { ...OFFICER, body: { deadlineAt: inDays(30) } })).status,
    ).toBe(400); // deadline after the start
    expect((await h.call("PATCH", "/events/01J000000000000000000NOPE", { ...OFFICER, body: { title: "Ghost" } })).status).toBe(
      404,
    );
  });

  it("returns 404 for unknown events and 400 for a bad answer", async () => {
    expect((await h.call("GET", "/events/01J000000000000000000NOPE", PLAYER)).status).toBe(404);
    expect((await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "sure" } })).status).toBe(
      400,
    );
  });
});

describe("Foundry legions", () => {
  let h: Harness;
  let foundryId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/events", {
      ...OFFICER,
      body: {
        kind: "foundry",
        title: "Foundry",
        startsAt: inDays(10),
        sessions: [
          { id: "L1", label: "Legion 1", startsAt: inDays(10, 12) },
          { id: "L2", label: "Legion 2", startsAt: inDays(10, 19) },
        ],
      },
    });
    expect(res.status).toBe(201);
    foundryId = res.body.eventId as string;
  });
  afterAll(() => h.cleanup());

  it("keeps both legions in one event, starting when the first one does", async () => {
    const detail = await h.call("GET", `/events/${foundryId}`, OFFICER);
    expect(detail.body.sessions).toEqual([
      { id: "L1", label: "Legion 1", startsAt: inDays(10, 12) },
      { id: "L2", label: "Legion 2", startsAt: inDays(10, 19) },
    ]);
    expect(detail.body.startsAt).toBe(inDays(10, 12));
  });

  it("lets a player pick one legion, and switching replaces the first pick", async () => {
    const first = await h.call("PUT", `/events/${foundryId}/answers/100000001`, {
      ...PLAYER,
      body: { answer: "yes", sessionId: "L1" },
    });
    expect(first.body).toMatchObject({ answer: "yes", sessionId: "L1" });

    const second = await h.call("PUT", `/events/${foundryId}/answers/100000001`, {
      ...PLAYER,
      body: { answer: "yes", sessionId: "L2" },
    });
    expect(second.body).toMatchObject({ answer: "yes", sessionId: "L2" });

    const detail = await h.call("GET", `/events/${foundryId}`, OFFICER);
    expect(detail.body.counts).toMatchObject({ yes: 1, bySession: { L2: 1 } });
    const mine = (detail.body.members as { playerId: string; sessionId: string | null }[]).find(
      (m) => m.playerId === "100000001",
    );
    expect(mine?.sessionId).toBe("L2"); // never in both legions
  });

  it("requires a legion for yes, and refuses one for no", async () => {
    const noLegion = await h.call("PUT", `/events/${foundryId}/answers/100000001`, { ...PLAYER, body: { answer: "yes" } });
    expect(noLegion.status).toBe(400);
    expect(noLegion.body.title).toContain("Legion 1 or Legion 2");

    const wrong = await h.call("PUT", `/events/${foundryId}/answers/100000001`, {
      ...PLAYER,
      body: { answer: "yes", sessionId: "L9" },
    });
    expect(wrong.status).toBe(400);

    const noWithLegion = await h.call("PUT", `/events/${foundryId}/answers/100000001`, {
      ...PLAYER,
      body: { answer: "no", sessionId: "L1" },
    });
    expect(noWithLegion.status).toBe(400);

    const plainNo = await h.call("PUT", `/events/${foundryId}/answers/100000001`, { ...PLAYER, body: { answer: "no" } });
    expect(plainNo.status).toBe(200);
    expect(plainNo.body.sessionId).toBeUndefined();
  });

  it("counts each legion separately for officers", async () => {
    await h.call("PUT", `/events/${foundryId}/answers/100000002`, { ...ALT, body: { answer: "yes", sessionId: "L1" } });
    await h.call("PUT", `/events/${foundryId}/answers/100000005`, { ...OFFICER, body: { answer: "yes", sessionId: "L2" } });
    const detail = await h.call("GET", `/events/${foundryId}`, OFFICER);
    expect(detail.body.counts).toMatchObject({ yes: 2, no: 1, bySession: { L1: 1, L2: 1 } });
  });
});
