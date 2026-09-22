import { describe, expect, it } from "vitest";
import type { FortressBuffPool } from "./api";
import { formatRewardValue, poolRewardValue } from "./rewardValues";

const pool = (gemValuation?: FortressBuffPool["gemValuation"]): FortressBuffPool => ({
  poolId: "speedups",
  alliance: "POP",
  buff: "speedup",
  quantity: 400,
  remaining: 350,
  source: "Current cycle",
  acquiredAt: "2026-09-22T00:00:00.000Z",
  createdBy: "officer",
  assignments: [],
  ...(gemValuation ? { gemValuation } : {}),
});

describe("reward Gem values", () => {
  it("values a split speedup assignment by quantity", () => {
    const value = poolRewardValue(pool({ min: 550, max: 800, confidence: "low", basis: "range" }), 50);
    expect(value).toEqual({ min: 27_500, max: 40_000, unvaluedUnits: 0 });
    expect(formatRewardValue(value)).toBe("≈ 27,500–40,000 Gems");
  });

  it("keeps unknown items separate from the known total", () => {
    expect(poolRewardValue(pool(), 20)).toEqual({ min: 0, max: 0, unvaluedUnits: 20 });
    expect(formatRewardValue(poolRewardValue(pool(), 20))).toBe("Value pending");
  });
});
