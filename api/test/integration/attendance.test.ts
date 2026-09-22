import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Repository } from "../../src/data/repository.js";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

const inDays = (days: number, hour = 19) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * An event that already happened. Participation only weighs events that have started — you
 * cannot fail to sign up for something still ahead — and the API refuses to schedule one in the
 * past, so a finished event is written straight to the table.
 */
const pastEvent = async (h: Harness, eventId: string, daysAgo: number) => {
  const startsAt = inDays(-daysAgo);
  await h.repo.createEvent(
    {
      eventId,
      alliance: "POP",
      kind: "bear",
      title: `Past event ${eventId}`,
      startsAt,
      deadlineAt: inDays(-daysAgo - 1),
      sessions: [],
      createdBy: "officer",
    },
    { id: "officer", via: "web" },
  );
  return eventId;
};

describe("attendance", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/events", {
      ...OFFICER,
      body: {
        kind: "foundry",
        title: "Foundry",
        startsAt: inDays(10),
        sessions: [{ id: "L1", label: "Legion 1", startsAt: inDays(10, 12), starters: 2, subs: 2 }],
      },
    });
    eventId = res.body.eventId as string;
  });
  afterAll(() => h.cleanup());

  it("lets officers record who turned up, and only officers", async () => {
    const saved = await h.call("PUT", `/events/${eventId}/attendance/100000001`, {
      ...OFFICER,
      body: { status: "present", sessionId: "L1", note: "on time" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ playerId: "100000001", status: "present", sessionId: "L1", source: "officer" });

    expect(
      (await h.call("PUT", `/events/${eventId}/attendance/100000001`, { ...PLAYER, body: { status: "present" } })).status,
    ).toBe(403);
    expect(
      (await h.call("PUT", `/events/${eventId}/attendance/100000001`, { ...OFFICER, body: { status: "showed-up" } })).status,
    ).toBe(400);
    expect(
      (await h.call("PUT", `/events/${eventId}/attendance/100000001`, { ...OFFICER, body: { status: "present", sessionId: "L9" } }))
        .status,
    ).toBe(400);
  });

  it("reports participation for an account, and keeps it to the member and officers", async () => {
    await pastEvent(h, "PAST-1", 3);
    await h.call("PUT", "/events/PAST-1/attendance/100000001", { ...OFFICER, body: { status: "present" } });

    const mine = await h.call("GET", "/accounts/100000001/reliability", PLAYER);
    expect(mine.body).toMatchObject({ attended: 1, noShows: 0, rate: 1 });

    // An account the alliance has known since before that battle, which said nothing about it:
    // silence counts now, at half weight, instead of reading as "fully reliable".
    const longStanding = new Repository(h.db, h.tableName, () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await longStanding.createAccount(
      { playerId: "700000123", name: "Quiet", alliance: "POP", status: "active" },
      { id: "seed", via: "seed" },
    );
    const quiet = await h.call("GET", "/accounts/700000123/reliability", OFFICER);
    expect(quiet.body).toMatchObject({ attended: 0, unregistered: 1, rate: 0 });

    // And one created only just now is not blamed for a battle it predates.
    const newcomer = await h.call("GET", "/accounts/100000005/reliability", OFFICER);
    expect(newcomer.body).toMatchObject({ unregistered: 0 });
    expect(newcomer.body.rate).toBeUndefined();

    expect((await h.call("GET", "/accounts/100000005/reliability", PLAYER)).status).toBe(403);
  });

  it("costs double when somebody signs up and does not come, and a correction undoes it", async () => {
    await pastEvent(h, "PAST-2", 2);
    // Signed up, then absent: the expensive kind, because a slot was planned around them.
    await h.repo.setAnswer(
      { eventId: "PAST-2", startsAt: inDays(-2), deadlineAt: inDays(-3) },
      "100000001",
      { answer: "yes" },
      "player",
      { id: "player", via: "web" },
      undefined,
      { historic: true },
    );
    await h.call("PUT", "/events/PAST-2/attendance/100000001", { ...OFFICER, body: { status: "absent" } });

    // One attended against one no-show at double weight: 1 / (1 + 2).
    expect((await h.call("GET", "/accounts/100000001/reliability", PLAYER)).body).toMatchObject({
      attended: 1,
      noShows: 1,
      rate: 1 / 3,
    });

    // An officer corrects it: they were there after all.
    await h.call("PUT", "/events/PAST-2/attendance/100000001", { ...OFFICER, body: { status: "present" } });
    expect((await h.call("GET", "/accounts/100000001/reliability", PLAYER)).body).toMatchObject({
      attended: 2,
      noShows: 0,
      rate: 1,
    });
  });

  it("feeds the lineup estimate: a reliable member outranks a stronger no-show", async () => {
    // Two members sign up; the stronger one has missed events, the weaker one always turns up.
    await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "yes", sessionId: "L1" } });
    await h.call("PUT", `/events/${eventId}/answers/100000008`, { ...OFFICER, body: { answer: "yes", sessionId: "L1" } });

    // A battle that already happened: Aurora was absent, Poppy was there.
    await pastEvent(h, "PAST-3", 1);
    await h.call("PUT", "/events/PAST-3/attendance/100000008", { ...OFFICER, body: { status: "absent" } });
    await h.call("PUT", "/events/PAST-3/attendance/100000001", { ...OFFICER, body: { status: "present" } });

    const detail = await h.call("GET", `/events/${eventId}`, OFFICER);
    const list = (detail.body.sessions as { id: string; signedUpList: { playerId: string; attendanceRate: number | null }[] }[]).find(
      (s) => s.id === "L1",
    )!.signedUpList;
    const poppy = list.find((e) => e.playerId === "100000001")!;
    const aurora = list.find((e) => e.playerId === "100000008")!;
    expect(poppy.attendanceRate).toBe(1);
    expect(aurora.attendanceRate).toBe(0);
  });
});
