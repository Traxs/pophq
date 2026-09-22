import type { FortressBuffPool, MemberRewardAssignment } from "./api";

export interface RewardValue {
  min: number;
  max: number;
  unvaluedUnits: number;
}

export const emptyRewardValue = (): RewardValue => ({ min: 0, max: 0, unvaluedUnits: 0 });

export function addRewardValue(total: RewardValue, pool: Pick<FortressBuffPool, "gemValuation">, amount: number): RewardValue {
  if (!pool.gemValuation) return { ...total, unvaluedUnits: total.unvaluedUnits + amount };
  return {
    ...total,
    min: total.min + pool.gemValuation.min * amount,
    max: total.max + pool.gemValuation.max * amount,
  };
}

export function poolRewardValue(pool: FortressBuffPool, amount = pool.quantity): RewardValue {
  return addRewardValue(emptyRewardValue(), pool, amount);
}

export function assignmentRewardValue(item: MemberRewardAssignment): RewardValue {
  return addRewardValue(emptyRewardValue(), item.pool, item.amount);
}

export function formatRewardValue(value: RewardValue): string {
  if (value.min === 0 && value.max === 0) return value.unvaluedUnits > 0 ? "Value pending" : "0 Gems";
  const min = Math.round(value.min);
  const max = Math.round(value.max);
  const known = min === max
    ? `≈ ${min.toLocaleString()} Gems`
    : `≈ ${min.toLocaleString()}–${max.toLocaleString()} Gems`;
  return value.unvaluedUnits > 0 ? `${known} + ${value.unvaluedUnits.toLocaleString()} unvalued` : known;
}
