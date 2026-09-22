import { describe, expect, it } from "vitest";
import { parseFortressBuffPool, parseFortressBuffPools } from "./fortressBuffs.js";

const ctx = { poolId: "POOL-1", alliance: "POP", createdBy: "r4", now: new Date("2026-09-22T12:00:00.000Z") };

describe("parseFortressBuffPool", () => {
  it("registers the whole batch as available", () => {
    expect(parseFortressBuffPool({ buff: "health", quantity: 3, source: "Fort 4" }, ctx)).toMatchObject({
      buff: "health",
      quantity: 3,
      remaining: 3,
      source: "Fort 4",
      acquiredAt: ctx.now.toISOString(),
      gemValuation: { min: 20_000, max: 20_000, confidence: "medium" },
    });
  });

  it("rejects unsupported rewards and empty batches", () => {
    expect(() => parseFortressBuffPool({ buff: "speedups", quantity: 1, source: "Fort 7" }, ctx)).toThrow();
    expect(() => parseFortressBuffPool({ buff: "damage", quantity: 0, source: "Fort 7" }, ctx)).toThrow();
  });
});

describe("parseFortressBuffPools", () => {
  const bulkCtx = {
    ...ctx,
    batchId: "BATCH-1",
    poolIds: {
      allocatable: "A", speedup: "S", health: "H", hero_shard: "HS", teleport: "T",
      damage: "D", deployment: "P", stronghold_material: "SM", stronghold_component: "SC",
      stronghold_hero_shard: "SHS", fire_crystal: "FC",
    },
  };

  it("registers a mixed weekly haul in one operation and skips zeroes", () => {
    expect(parseFortressBuffPools({ quantities: {
      allocatable: 0, speedup: 0, health: 24, hero_shard: 0, teleport: 0,
      damage: 0, deployment: 36, stronghold_material: 0, stronghold_component: 0,
      stronghold_hero_shard: 0, fire_crystal: 0,
    }, source: "Phase 3" }, bulkCtx)).toEqual([
      expect.objectContaining({ poolId: "H", buff: "health", quantity: 24, remaining: 24, source: "Phase 3", gemValuation: { min: 20_000, max: 20_000, confidence: "medium", basis: expect.any(String) } }),
      expect.objectContaining({ poolId: "P", buff: "deployment", quantity: 36, remaining: 36, source: "Phase 3", gemValuation: { min: 20_000, max: 20_000, confidence: "low", basis: expect.any(String) } }),
    ]);
    expect(parseFortressBuffPools({ quantities: {
      allocatable: 1, speedup: 0, health: 0, hero_shard: 0, teleport: 0,
      damage: 0, deployment: 0, stronghold_material: 0, stronghold_component: 0,
      stronghold_hero_shard: 0, fire_crystal: 0,
    }, source: "Phase 3" }, bulkCtx)[0]).toMatchObject({ batchId: "BATCH-1" });
  });

  it("rejects an empty haul", () => {
    expect(() => parseFortressBuffPools({ quantities: {
      allocatable: 0, speedup: 0, health: 0, hero_shard: 0, teleport: 0,
      damage: 0, deployment: 0, stronghold_material: 0, stronghold_component: 0,
      stronghold_hero_shard: 0, fire_crystal: 0,
    }, source: "Phase 3" }, bulkCtx)).toThrow(/Invalid Fortress buff haul/);
  });
});
