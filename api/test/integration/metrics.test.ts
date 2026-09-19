import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

describe("GET /v1/metrics/alliance", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
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
});
