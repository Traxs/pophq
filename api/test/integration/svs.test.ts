import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

/** The Monday of a week that starts a few days from now, so the round is still collecting. */
const weekStart = () => {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
};

describe("SvS rounds and preferences", () => {
  let h: Harness;
  let roundId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/svs-rounds", {
      ...OFFICER,
      body: { label: "SvS week 41", weekStart: weekStart() },
    });
    expect(res.status).toBe(201);
    roundId = res.body.roundId as string;
  });
  afterAll(() => h.cleanup());

  it("only lets officers open a round, and fills in the usual three days", async () => {
    expect((await h.call("POST", "/svs-rounds", { ...PLAYER, body: { label: "Mine", weekStart: weekStart() } })).status).toBe(403);

    const res = await h.call("GET", `/svs-rounds/${roundId}`, PLAYER);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("collecting");
    const days = res.body.days as { id: string; buff: string; date: string; demand: number[] }[];
    expect(days.map((d) => d.buff)).toEqual(["construction", "research", "training"]);
    expect(days[0]!.demand).toHaveLength(48);
    expect(days[0]!.demand.every((n) => n === 0)).toBe(true);
  });

  it("saves a member's times and shows them back", async () => {
    const res = await h.call("PUT", `/svs-rounds/${roundId}/preferences/100000001`, {
      ...PLAYER,
      body: {
        days: [
          { dayId: "construction", slots: [36, 37, 20] },
          { dayId: "research", anyTime: true },
          { dayId: "training", unavailable: true, note: "night shift" },
        ],
      },
    });
    expect(res.status).toBe(200);

    const round = await h.call("GET", `/svs-rounds/${roundId}`, PLAYER);
    const mine = round.body.yourPreferences as { dayId: string; slots: number[]; anyTime: boolean }[];
    expect(mine.map((d) => d.dayId)).toEqual(["construction", "research", "training"]);
    expect(mine[0]!.slots).toEqual([36, 37, 20]);
    expect(round.body.answeredBy).toBe(1);

    const days = round.body.days as { id: string; demand: number[]; anyTime: number; unavailable: number }[];
    expect(days[0]!.demand[36]).toBe(1);
    expect(days[0]!.demand[0]).toBe(0);
    expect(days[1]!.anyTime).toBe(1);
    expect(days[2]!.unavailable).toBe(1);
  });

  it("replaces the previous answer rather than adding to it", async () => {
    await h.call("PUT", `/svs-rounds/${roundId}/preferences/100000001`, {
      ...PLAYER,
      body: { days: [{ dayId: "construction", slots: [10] }] },
    });
    const round = await h.call("GET", `/svs-rounds/${roundId}`, PLAYER);
    expect((round.body.yourPreferences as unknown[]).length).toBe(1);
    const days = round.body.days as { demand: number[] }[];
    expect(days[0]!.demand[36]).toBe(0);
    expect(days[0]!.demand[10]).toBe(1);
  });

  it("refuses to set someone else's times, officer or not", async () => {
    expect(
      (await h.call("PUT", `/svs-rounds/${roundId}/preferences/100000005`, { ...OFFICER, body: { days: [] } })).status,
    ).toBe(403);
    expect(
      (await h.call("PUT", `/svs-rounds/${roundId}/preferences/100000001`, { as: "other", body: { days: [] } })).status,
    ).toBe(403);
  });

  it("validates the times themselves", async () => {
    const bad = async (days: unknown) =>
      (await h.call("PUT", `/svs-rounds/${roundId}/preferences/100000001`, { ...PLAYER, body: { days } })).status;
    expect(await bad([{ dayId: "construction", slots: [1, 2, 3, 4] }])).toBe(400);
    expect(await bad([{ dayId: "construction", slots: [48] }])).toBe(400);
    expect(await bad([{ dayId: "harvest", slots: [1] }])).toBe(400);
    expect(await bad([{ dayId: "construction", anyTime: true, unavailable: true }])).toBe(400);
  });

  it("closes preferences at the deadline, in the write", async () => {
    // A round whose buff days are today: its deadline has already passed, so it is planning.
    const today = new Date().toISOString().slice(0, 10);
    const created = await h.call("POST", "/svs-rounds", {
      ...OFFICER,
      body: { label: "Starting today", days: [{ buff: "construction", date: today }] },
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe("planning");

    const late = await h.call("PUT", `/svs-rounds/${created.body.roundId}/preferences/100000001`, {
      ...PLAYER,
      body: { days: [{ dayId: "construction", slots: [1] }] },
    });
    expect(late.status).toBe(409);
    expect(String(late.body.title)).toMatch(/closed/i);
  });

  it("refuses a round that is already over", async () => {
    const res = await h.call("POST", "/svs-rounds", {
      ...OFFICER,
      body: { label: "Last month", days: [{ buff: "construction", date: "2026-01-05" }] },
    });
    expect(res.status).toBe(400);
  });
});

describe("kudos", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
  });
  afterAll(() => h.cleanup());

  it("lets officers award, and shows the decayed score", async () => {
    const res = await h.call("POST", "/accounts/100000001/kudos", {
      ...OFFICER,
      body: { points: 10, reason: "Covered a night buff slot" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId: "100000001", points: 10, reason: "Covered a night buff slot" });

    // Ninety days old, so worth half.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await h.call("POST", "/accounts/100000001/kudos", {
      ...OFFICER,
      body: { points: 10, reason: "Old favour", awardedAt: old },
    });

    const list = await h.call("GET", "/accounts/100000001/kudos", PLAYER);
    expect((list.body.items as unknown[]).length).toBe(2);
    expect(list.body.score as number).toBeCloseTo(15, 1);
  });

  it("keeps members out of each other's kudos, but lets them see their own", async () => {
    expect((await h.call("GET", "/accounts/100000005/kudos", PLAYER)).status).toBe(403);
    expect((await h.call("GET", "/accounts/100000001/kudos", PLAYER)).status).toBe(200);
    expect(
      (await h.call("POST", "/accounts/100000001/kudos", { ...PLAYER, body: { points: 5, reason: "Myself" } })).status,
    ).toBe(403);
  });

  it("refuses an award that says nothing", async () => {
    expect((await h.call("POST", "/accounts/100000001/kudos", { ...OFFICER, body: { points: 0, reason: "Nothing" } })).status).toBe(400);
    expect((await h.call("POST", "/accounts/100000001/kudos", { ...OFFICER, body: { points: 5 } })).status).toBe(400);
  });
});
