import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player" };

describe("roster and dev tools", () => {
  let h: Harness;
  let plain: Harness;

  beforeAll(async () => {
    [h, plain] = await Promise.all([createHarness({ devTools: true }), createHarness()]);
    await seedDemo(h.repo, new Date());
  });
  afterAll(() => Promise.all([h.cleanup(), plain.cleanup()]));

  it("gives officers a roster with latest and previous power", async () => {
    const res = await h.call("GET", "/roster", OFFICER);
    expect(res.status).toBe(200);
    const items = res.body.items as { playerId: string; power: number | null; previousPower: number | null }[];
    expect(items).toHaveLength(38);
    const poppy = items.find((i) => i.playerId === "100000001")!;
    expect(poppy.power).toBeGreaterThan(0);
    expect(poppy.previousPower).toBeGreaterThan(0);
  });

  it("keeps the roster officer-only", async () => {
    expect((await h.call("GET", "/roster", PLAYER)).status).toBe(403);
  });

  it("links the demo personas to their accounts", async () => {
    const me = await h.call("GET", "/me", PLAYER);
    expect((me.body.accounts as { name: string }[]).map((a) => a.name).sort()).toEqual(["Goatzilla", "Poppy"]);
  });

  it("adds random members with history", async () => {
    const res = await h.call("POST", "/dev/members", { ...OFFICER, body: { count: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    const roster = await h.call("GET", "/roster", OFFICER);
    expect(roster.body.items as unknown[]).toHaveLength(41);
  });

  it("backfills older history for an account", async () => {
    const before = await h.repo.listReports("100000003");
    const res = await h.call("POST", "/dev/history", { ...PLAYER, body: { playerId: "100000003", months: 6 } });
    expect(res.status).toBe(200);
    const after = await h.repo.listReports("100000003");
    expect(after.length).toBeGreaterThan(before.length);
    const oldest = after.map((r) => r.effectiveAt).sort()[0]!;
    expect(oldest < before.map((r) => r.effectiveAt).sort()[0]!).toBe(true);
  });

  it("validates dev tool input", async () => {
    expect((await h.call("POST", "/dev/members", { ...OFFICER, body: { count: 500 } })).status).toBe(400);
  });

  it("does not expose dev tools unless the local server mounts them", async () => {
    expect((await plain.call("POST", "/dev/members", { ...OFFICER, body: { count: 1 } })).status).toBe(404);
    expect((await plain.call("POST", "/dev/reset", OFFICER)).status).toBe(404);
  });
});
