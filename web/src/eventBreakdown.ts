// The "who answered what" table on the Events page. A name alone does not tell an officer
// whether to chase someone, so the list carries the numbers the decision is made on.
import type { EventMember } from "./api";

/** The most recent month with a reading, for a trailing series that ends in unknown months. */
export function latestKnown(values: readonly (number | null)[]): number | undefined {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

/**
 * Which number this event is judged on: Foundry strength for a Foundry, city power otherwise.
 * The table sorts by the same metric it shows, or the order looks broken.
 */
export type BreakdownMetric = "foundry" | "power";

export const valueOf = (member: EventMember, metric: BreakdownMetric): number | null =>
  metric === "foundry" ? member.foundryStrength : member.power;

/**
 * Strongest first, because that is who an officer chases when a legion is short. People with no
 * reading come last rather than counting as zero, and ties fall back to the name so the order
 * never wobbles between renders.
 */
export function sortForBreakdown(members: readonly EventMember[], metric: BreakdownMetric): EventMember[] {
  return [...members].toSorted(
    (a, b) => (valueOf(b, metric) ?? -1) - (valueOf(a, metric) ?? -1) || a.name.localeCompare(b.name),
  );
}

/** Totals under the table: what this group is worth, and how much of it is unknown. */
export interface GroupTotals {
  people: number;
  strength: number;
  /** How many never reported this metric, so the total understates the group. */
  missing: number;
}

export function totalsOf(members: readonly EventMember[], metric: BreakdownMetric): GroupTotals {
  return {
    people: members.length,
    strength: members.reduce((sum, m) => sum + (valueOf(m, metric) ?? 0), 0),
    missing: members.filter((m) => valueOf(m, metric) === null).length,
  };
}
