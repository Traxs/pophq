import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  });

  it("keeps event-type participation officer-only", async () => {
    expect((await h.call("GET", "/metrics/event-participation?kind=foundry", PLAYER)).status).toBe(403);
  });
});
