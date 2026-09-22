import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { parseNewEvent } from "../../src/domain/events.js";
import { addDemoEvents, seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

describe("GET /v1/metrics/alliance", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    const now = new Date();
    await seedDemo(h.repo, now);
    await addDemoEvents(h.repo, now, { id: "seed", via: "seed" });
  });
  afterAll(() => h.cleanup());

  it("gives officers a growth series with movers", async () => {
    const res = await h.call("GET", "/metrics/alliance?weeks=8", OFFICER);
    expect(res.status).toBe(200);
    const body = res.body as {
      metric: string;
      weeks: number;
      points: { at: string; total: number; members: number }[];
      gainers: { name: string; percent: number }[];
      stalled: unknown[];
      missing: unknown[];
    };
    expect(body).toMatchObject({ metric: "city_power", weeks: 8 });
    expect(body.points).toHaveLength(8);
    // The demo alliance grows, so the last point is the biggest and covers most members.
    expect(body.points.at(-1)!.total).toBeGreaterThan(body.points[0]!.total);
    expect(body.points.at(-1)!.members).toBeGreaterThan(30);
    expect(body.gainers.length).toBeGreaterThan(5);
    expect(body.gainers[0]!.percent).toBeGreaterThanOrEqual(body.gainers.at(-1)!.percent);
  });

  it("can report combat score instead, and clamps the window", async () => {
    const res = await h.call("GET", "/metrics/alliance?metric=foundry_strength&weeks=999", OFFICER);
    expect(res.body).toMatchObject({ metric: "foundry_strength", weeks: 52 });
  });

  it("is officer-only", async () => {
    expect((await h.call("GET", "/metrics/alliance", PLAYER)).status).toBe(403);
  });

  it("reports weekly alliance attendance and carries quiet weeks forward", async () => {
    const res = await h.call("GET", "/metrics/alliance-attendance?weeks=12", OFFICER);
    expect(res.status).toBe(200);
    const body = res.body as { points: { value: number; events: number; records: number }[] };
    expect(body.points).toHaveLength(12);
    expect(body.points.every((point) => point.value >= 0 && point.value <= 100)).toBe(true);
    const quiet = body.points.findIndex((point, index) => index > 0 && point.events === 0);
    if (quiet > 0) expect(body.points[quiet]!.value).toBe(body.points[quiet - 1]!.value);
  });

  it("keeps alliance attendance officer-only", async () => {
    expect((await h.call("GET", "/metrics/alliance-attendance", PLAYER)).status).toBe(403);
  });

  it("groups member participation by event type", async () => {
    const res = await h.call("GET", "/metrics/event-participation?kind=foundry&weeks=12", OFFICER);
    expect(res.status).toBe(200);
    const body = res.body as {
      kind: string;
      points: unknown[];
      members: {
        playerId: string;
        name: string;
        category: string;
        rate?: number;
        attended: number;
        events: number;
        linkedAccounts: { playerId: string; name: string }[];
      }[];
    };
    expect(body.kind).toBe("foundry");
    expect(body.points).toHaveLength(12);
    expect(body.members.length).toBeGreaterThan(30);
    expect(body.members.every((member) => ["always", "sometimes", "never", "no_history"].includes(member.category))).toBe(true);
    // Poppy and Goatzilla share one login. The main was present and the alt was absent, so this is
    // one person who attended—not two rows and not a 50% rate.
    expect(body.members.some((member) => member.name === "Goatzilla")).toBe(false);
    expect(body.members.find((member) => member.name === "Poppy")).toMatchObject({
      playerId: "100000001",
      category: "always",
      rate: 1,
      attended: 1,
      events: 1,
      linkedAccounts: [{ playerId: "100000002", name: "Goatzilla" }],
    });
    // Once an event has been reviewed, no record means the person did not participate.
    expect(body.members.find((member) => member.name === "FrostByte")).toMatchObject({
      category: "never",
      rate: 0,
      attended: 0,
      events: 1,
    });
    expect(body.members.filter((member) => member.category === "no_history")).toHaveLength(1); // one excused person
  });

  it("keeps event-type participation officer-only", async () => {
    expect((await h.call("GET", "/metrics/event-participation?kind=foundry", PLAYER)).status).toBe(403);
  });
});

describe("attendance evidence", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    const actor = { id: "fixture", via: "seed" as const };
    await h.repo.createAccount(parseNewAccount({ playerId: "710000001", name: "Scored" }), actor);
    await h.repo.createAccount(parseNewAccount({ playerId: "710000002", name: "Absent" }), actor);

    const day = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const l1At = new Date(day.setUTCHours(12, 0, 0, 0)).toISOString();
    const l2At = new Date(day.setUTCHours(19, 0, 0, 0)).toISOString();
    const l1 = parseNewEvent(
      { kind: "foundry", title: "Legacy L1", startsAt: l1At, sessions: [{ id: "L1", label: "Legion 1", startsAt: l1At }] },
      { eventId: "EVIDENCE-L1", createdBy: "fixture", now: new Date(day.getTime() - 24 * 60 * 60 * 1000) },
    );
    const l2 = parseNewEvent(
      { kind: "foundry", title: "Legacy L2", startsAt: l2At, sessions: [{ id: "L2", label: "Legion 2", startsAt: l2At }] },
      { eventId: "EVIDENCE-L2", createdBy: "fixture", now: new Date(day.getTime() - 24 * 60 * 60 * 1000) },
    );
    await h.repo.createEvent(l1, actor);
    await h.repo.createEvent(l2, actor);
    await h.repo.setAttendance({ eventId: l1.eventId, playerId: "710000001", status: "absent", source: "officer" }, actor);
    await h.repo.setAttendance({ eventId: l1.eventId, playerId: "710000002", status: "absent", source: "officer" }, actor);
    await h.repo.putResult({
      eventId: l2.eventId,
      sessionId: "L2",
      version: 1,
      outcome: "loss",
      ourScore: 1,
      opponentScore: 2,
      playerPoints: [{ playerId: "710000001", points: 50 }],
      recordedAt: l2At,
      recordedBy: "fixture",
    }, actor);

    // A partial scoreboard by itself is useful evidence for the named player, but it does not
    // make every unlisted roster member absent or add an incomplete event to alliance metrics.
    const partialAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const partial = parseNewEvent(
      { kind: "foundry", title: "Partial result", startsAt: partialAt, sessions: [{ id: "L1", label: "Legion 1", startsAt: partialAt }] },
      { eventId: "EVIDENCE-PARTIAL", createdBy: "fixture", now: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    );
    await h.repo.createEvent(partial, actor);
    await h.repo.putResult({
      eventId: partial.eventId,
      sessionId: "L1",
      version: 1,
      outcome: "win",
      ourScore: 2,
      opponentScore: 1,
      playerPoints: [{ playerId: "710000001", points: 75 }],
      recordedAt: partialAt,
      recordedBy: "fixture",
    }, actor);
  });
  afterAll(() => h.cleanup());

  it("groups legacy legions, credits positive scores and ignores incomplete denominators", async () => {
    const res = await h.call("GET", "/metrics/event-participation?kind=foundry&weeks=12", OFFICER);
    expect(res.status).toBe(200);
    const body = res.body as {
      eventCount: number;
      members: { playerId: string; rate?: number; attended: number; events: number }[];
    };
    expect(body.eventCount).toBe(1);
    expect(body.members.find((member) => member.playerId === "710000001")).toMatchObject({ rate: 1, attended: 1, events: 1 });
    expect(body.members.find((member) => member.playerId === "710000002")).toMatchObject({ rate: 0, attended: 0, events: 1 });
  });
});
