import { describe, expect, it } from "vitest";
import type { FortressBuffPool } from "../api";
import { rewardCycles } from "../rewardCycles";

const pool = (overrides: Partial<FortressBuffPool>): FortressBuffPool => ({
  poolId: "pool-1",
  alliance: "POP",
  buff: "health",
  quantity: 60,
  remaining: 60,
  source: "Phase 3",
  acquiredAt: "2026-09-22T00:00:00.000Z",
  createdBy: "officer",
  assignments: [],
  ...overrides,
});

describe("rewardCycles", () => {
  it("groups every pool in a registered batch and orders newest cycles first", () => {
    const cycles = rewardCycles([
      pool({ poolId: "old", batchId: "old-batch", acquiredAt: "2026-09-01T00:00:00.000Z" }),
      pool({ poolId: "health", batchId: "new-batch" }),
      pool({ poolId: "damage", batchId: "new-batch", buff: "damage" }),
    ]);
    expect(cycles.map((cycle) => cycle.key)).toEqual(["new-batch", "old-batch"]);
    expect(cycles[0]!.pools.map((item) => item.poolId).toSorted()).toEqual(["damage", "health"]);
  });

  it("uses the newer batch id when two cycles share the same acquisition date", () => {
    const cycles = rewardCycles([
      pool({ poolId: "old", batchId: "legacy-name", registeredAt: "2026-09-22T10:00:00.000Z" }),
      pool({ poolId: "new", batchId: "opaque-new-name", registeredAt: "2026-09-22T11:00:00.000Z" }),
    ]);
    expect(cycles.map((cycle) => cycle.key)).toEqual(["opaque-new-name", "legacy-name"]);
  });

  it("reconstructs a legacy haul from its exact source, timestamp and creator", () => {
    const cycles = rewardCycles([
      pool({ poolId: "legacy-health" }),
      pool({ poolId: "legacy-damage", buff: "damage" }),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.pools).toHaveLength(2);
  });
});
