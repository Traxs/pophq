import type { FortressBuffPool } from "./api";

export interface RewardCycle {
  key: string;
  source: string;
  acquiredAt: string;
  pools: FortressBuffPool[];
}

/** Groups durable batch ids and reconstructs pre-batch-id hauls without rewriting old data. */
export function rewardCycles(pools: FortressBuffPool[]): RewardCycle[] {
  const grouped = new Map<string, FortressBuffPool[]>();
  for (const pool of pools) {
    const key = pool.batchId ?? `legacy:${pool.acquiredAt}:${pool.source}:${pool.createdBy}`;
    grouped.set(key, [...(grouped.get(key) ?? []), pool]);
  }
  return [...grouped.entries()]
    .map(([key, groupedPools]) => ({
      key,
      source: groupedPools[0]!.source,
      acquiredAt: groupedPools[0]!.acquiredAt,
      pools: groupedPools.toSorted((a, b) => a.buff.localeCompare(b.buff)),
    }))
    .toSorted((a, b) => {
      const aRegistered = a.pools.map((pool) => pool.registeredAt ?? pool.acquiredAt).toSorted().at(-1)!;
      const bRegistered = b.pools.map((pool) => pool.registeredAt ?? pool.acquiredAt).toSorted().at(-1)!;
      return bRegistered.localeCompare(aRegistered);
    });
}
