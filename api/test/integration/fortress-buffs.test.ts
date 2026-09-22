import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const R4 = { as: "officer", groups: ["officer"] };
const R3 = { as: "r3-officer", groups: ["officer"] };
const MEMBER = { as: "player", headers: { "x-account-id": "100000001" } };
const OTHER_MEMBER = { as: "player", headers: { "x-account-id": "100000002" } };

describe("Fortress reward buffs", () => {
  let h: Harness;
  let poolId: string;
  let speedupPoolId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    await h.repo.linkAccount("r3-officer", "100000003", { id: "test", via: "seed" });
  });
  afterAll(() => h.cleanup());

  it("only lets an R4 or R5 register a valid reward batch", async () => {
    expect((await h.call("POST", "/fortress-buffs", { ...MEMBER, body: { buff: "health", quantity: 2, source: "Fort 4" } })).status).toBe(403);
    expect((await h.call("POST", "/fortress-buffs", { ...R3, body: { buff: "health", quantity: 2, source: "Fort 4" } })).status).toBe(403);

    const res = await h.call("POST", "/fortress-buffs", {
      ...R4,
      body: { buff: "health", quantity: 2, source: "Fort 4", acquiredAt: "2026-09-21" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ buff: "health", quantity: 2, remaining: 2, source: "Fort 4" });
    poolId = res.body.poolId as string;

    expect((await h.call("POST", "/fortress-buffs", { ...R4, body: { buff: "speed", quantity: 0, source: "x" } })).status).toBe(400);
  });

  it("registers a mixed haul with one request", async () => {
    const res = await h.call("POST", "/fortress-buffs/bulk", {
      ...R4,
      body: {
        quantities: {
          allocatable: 40, speedup: 400, health: 20, hero_shard: 200, teleport: 90,
          damage: 18, deployment: 22, stronghold_material: 150, stronghold_component: 100,
          stronghold_hero_shard: 420, fire_crystal: 600,
        },
        source: "Week 3 rewards",
        acquiredAt: "2026-09-22",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(11);
    expect(new Set((res.body.items as { batchId: string }[]).map((item) => item.batchId)).size).toBe(1);
    speedupPoolId = (res.body.items as { buff: string; poolId: string }[]).find((item) => item.buff === "speedup")!.poolId;
    expect(res.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ buff: "allocatable", quantity: 40, remaining: 40 }),
      expect.objectContaining({ buff: "speedup", quantity: 400, remaining: 400 }),
      expect.objectContaining({ buff: "stronghold_hero_shard", quantity: 420, remaining: 420 }),
      expect.objectContaining({ buff: "fire_crystal", quantity: 600, remaining: 600 }),
    ]));
    expect((await h.call("POST", "/fortress-buffs/bulk", {
      ...R4,
      body: { quantities: {
        allocatable: 0, speedup: 0, health: 0, hero_shard: 0, teleport: 0,
        damage: 0, deployment: 0, stronghold_material: 0, stronghold_component: 0,
        stronghold_hero_shard: 0, fire_crystal: 0,
      }, source: "Week 3 rewards" },
    })).status).toBe(400);
  });

  it("shows inventory and public eligibility without exposing the calculation", async () => {
    const list = await h.call("GET", "/fortress-buffs", MEMBER);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ poolId, remaining: 2 })]));

    const detail = await h.call("GET", `/fortress-buffs/${poolId}`, MEMBER);
    expect(detail.status).toBe(200);
    const candidates = detail.body.candidates as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.filter((candidate) => candidate.eligible).length).toBeGreaterThan(2);
    expect(candidates[0]).not.toHaveProperty("score");
    expect(candidates[0]).not.toHaveProperty("strength");
  });

  it("shows a member their own live place and complete weighted calculation", async () => {
    const res = await h.call("GET", "/reward-eligibility/mine", MEMBER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      playerId: "100000001",
      position: expect.any(Number),
      totalMembers: expect.any(Number),
      eligible: expect.any(Boolean),
      eligibleThrough: expect.any(Number),
      score: expect.any(Number),
      participationRate: expect.any(Number),
      strength: expect.any(Number),
      strongestStrength: expect.any(Number),
      strengthShare: expect.any(Number),
      kudosScore: expect.any(Number),
      bestKudosScore: expect.any(Number),
      kudosShare: expect.any(Number),
      weights: { participation: 0.6, strength: 0.2, kudos: 0.2 },
      allocation: expect.objectContaining({
        source: "Week 3 rewards",
        targetValueMin: expect.any(Number),
        targetValueMax: expect.any(Number),
        assignedValueMin: 0,
        assignedValueMax: 0,
        assignedUnvaluedUnits: 0,
      }),
    });
    expect(res.body.score as number).toBeCloseTo(
      (res.body.participationRate as number) * 0.6
        + (res.body.strengthShare as number) * 0.2
        + (res.body.kudosShare as number) * 0.2,
      8,
    );
  });

  it("shows officers the weighted inputs and assigns only eligible members", async () => {
    const detail = await h.call("GET", `/fortress-buffs/${poolId}`, R4);
    const candidates = detail.body.candidates as {
      playerId: string; eligible: boolean; score: number; participationRate: number;
      strength: number; strongestStrength: number; strengthShare: number; kudosShare: number;
      cycleRewardValueMin: number; cycleRewardValueMax: number; cycleUnvaluedUnits: number;
    }[];
    expect(candidates[0]).toMatchObject({
      position: 1,
      eligible: true,
      cycleRewardValueMin: 0,
      cycleRewardValueMax: 0,
      cycleUnvaluedUnits: 0,
    });
    expect(candidates[0]!.score).toBeTypeOf("number");
    expect(candidates[0]!.participationRate).toBeTypeOf("number");

    const selected = candidates.find((candidate) => candidate.playerId === "100000001")!;
    expect(selected.eligible).toBe(true);
    const assigned = await h.call("POST", `/fortress-buffs/${poolId}/assignments`, { ...R4, body: { playerId: selected.playerId } });
    expect(assigned.status).toBe(201);
    expect(assigned.body.status).toBe("recommended");
    const eligibility = assigned.body.eligibility as { position: number; score: number };
    expect(eligibility).toMatchObject({
      position: expect.any(Number),
      eligibleThrough: expect.any(Number),
      score: selected.score,
      participationRate: selected.participationRate,
      strength: selected.strength,
      strongestStrength: selected.strongestStrength,
      strengthShare: selected.strengthShare,
      kudosShare: selected.kudosShare,
      weights: { participation: 0.6, strength: 0.2, kudos: 0.2 },
    });
    expect(eligibility.score).toBeCloseTo(
      selected.participationRate * 0.6 + selected.strengthShare * 0.2 + selected.kudosShare * 0.2,
      8,
    );
    expect((await h.call("POST", `/fortress-buffs/${poolId}/assignments`, { ...R4, body: { playerId: selected.playerId } })).status).toBe(403);

    const mine = await h.call("GET", "/reward-assignments/mine", MEMBER);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([expect.objectContaining({
      playerId: "100000001",
      amount: 1,
      status: "recommended",
      eligibility: expect.objectContaining({ position: eligibility.position, score: selected.score }),
      pool: expect.objectContaining({ poolId, buff: "health", source: "Fort 4" }),
    })]);
    expect(mine.body.currentCycle).toMatchObject({ source: "Week 3 rewards", acquiredAt: "2026-09-22T00:00:00.000Z", items: [] });
    expect((await h.call("GET", "/reward-assignments/mine", OTHER_MEMBER)).body.items).toEqual([]);
    const privateDetail = await h.call("GET", `/fortress-buffs/${poolId}`, OTHER_MEMBER);
    expect((privateDetail.body.assignments as Record<string, unknown>[])[0]).not.toHaveProperty("eligibility");

    const after = await h.call("GET", `/fortress-buffs/${poolId}`, MEMBER);
    expect(after.body.remaining).toBe(1);
    expect(after.body.assignments).toEqual([expect.objectContaining({ playerId: selected.playerId })]);
    expect((after.body.candidates as { playerId: string }[]).some((candidate) => candidate.playerId === selected.playerId)).toBe(false);

    const confirmed = await h.call("POST", `/fortress-buffs/${poolId}/assignments/${selected.playerId}/confirm`, R4);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ playerId: selected.playerId, status: "confirmed", confirmedAt: expect.any(String) });
    const confirmedMine = (await h.call("GET", "/reward-assignments/mine", MEMBER)).body as { items: Record<string, unknown>[] };
    expect(confirmedMine.items[0]).toMatchObject({ status: "confirmed" });
  });

  it("splits a reward pool by an officer-selected amount", async () => {
    const detail = await h.call("GET", `/fortress-buffs/${speedupPoolId}`, R4);
    const speedupCandidates = detail.body.candidates as { playerId: string; recommendedAmount: number }[];
    expect(Math.max(...speedupCandidates.map((candidate) => candidate.recommendedAmount))).toBeLessThanOrEqual(
      Math.ceil(400 / speedupCandidates.length),
    );
    const selected = speedupCandidates[0]!;
    const assigned = await h.call("POST", `/fortress-buffs/${speedupPoolId}/assignments`, {
      ...R4,
      body: { playerId: selected.playerId, amount: 25 },
    });
    expect(assigned.status).toBe(201);
    expect(assigned.body.amount).toBe(25);
    const after = await h.call("GET", `/fortress-buffs/${speedupPoolId}`, R4);
    expect(after.body.remaining).toBe(375);
    const inventory = (await h.call("GET", "/fortress-buffs", R4)).body as { items: { buff: string; poolId: string }[] };
    const anotherPool = inventory.items.find(
      (item: { buff: string }) => item.buff === "damage",
    )!;
    const sameCycle = await h.call("GET", `/fortress-buffs/${anotherPool.poolId}`, R4);
    expect((sameCycle.body.candidates as Record<string, unknown>[]).find((candidate) => candidate.playerId === selected.playerId)).toMatchObject({
      cycleRewardValueMin: 13_750,
      cycleRewardValueMax: 20_000,
      cycleUnvaluedUnits: 0,
    });
  });
});
