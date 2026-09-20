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

  it("reports reliability for an account, and keeps it to the member and officers", async () => {
    const mine = await h.call("GET", "/accounts/100000001/reliability", PLAYER);
    expect(mine.body).toMatchObject({ kept: 1, missed: 0, sample: 1, rate: 1 });

    const asOfficer = await h.call("GET", "/accounts/100000005/reliability", OFFICER);
    expect(asOfficer.body).toMatchObject({ sample: 0 });
    expect(asOfficer.body.rate).toBeUndefined(); // nothing checked yet: no rate at all

    expect((await h.call("GET", "/accounts/100000005/reliability", PLAYER)).status).toBe(403);
  });

  it("counts a missed commitment and recording again replaces the earlier record", async () => {
    const second = await h.call("POST", "/events", {
      ...OFFICER,
      body: { kind: "bear", title: "Bear hunt", startsAt: inDays(11) },
    });
    const secondId = second.body.eventId as string;

    await h.call("PUT", `/events/${secondId}/attendance/100000001`, { ...OFFICER, body: { status: "absent" } });
    expect((await h.call("GET", "/accounts/100000001/reliability", PLAYER)).body).toMatchObject({
      kept: 1,
      missed: 1,
      sample: 2,
      rate: 0.5,
    });

    // An officer corrects it: they were there after all.
    await h.call("PUT", `/events/${secondId}/attendance/100000001`, { ...OFFICER, body: { status: "present" } });
    expect((await h.call("GET", "/accounts/100000001/reliability", PLAYER)).body).toMatchObject({
      kept: 2,
      missed: 0,
      sample: 2,
      rate: 1,
    });
  });

  it("feeds the lineup estimate: a reliable member outranks a stronger no-show", async () => {
    // Two members sign up; the stronger one has missed events, the weaker one always turns up.
    await h.call("PUT", `/events/${eventId}/answers/100000001`, { ...PLAYER, body: { answer: "yes", sessionId: "L1" } });
    await h.call("PUT", `/events/${eventId}/answers/100000008`, { ...OFFICER, body: { answer: "yes", sessionId: "L1" } });

    const third = await h.call("POST", "/events", {
      ...OFFICER,
      body: { kind: "bear", title: "Past bear", startsAt: inDays(12) },
    });
    for (let i = 0; i < 4; i += 1) {
      await h.call("PUT", `/events/${third.body.eventId}/attendance/100000008`, { ...OFFICER, body: { status: "absent" } });
    }

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
