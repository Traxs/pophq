// Troops in the power report. Each type has its own level, and Helios is an upgrade on top of
// that level — so somebody can hold it on all three at once. The API is the authority
// (api/src/domain/measurements.ts); this only builds what the form sends.

export const TROOP_TYPES = ["infantry", "lancer", "marksman"] as const;
export type TroopType = (typeof TROOP_TYPES)[number];

export const TROOP_LABELS: Record<TroopType, string> = {
  infantry: "Infantry",
  lancer: "Lancer",
  marksman: "Marksman",
};

export interface TroopEntry {
  level: string;
  helios: boolean;
}

export type TroopDraft = Record<TroopType, TroopEntry>;

/**
 * What the report says about troops.
 *
 * A level is only sent when it was filled in, because a blank field is "I didn't say", not a
 * level of nothing. Helios is always sent, both ways: sending only the ticks would leave the
 * previous report's "yes" standing as the current value, and the box could never be unticked.
 */
export function troopValues(troops: TroopDraft): { metric: string; value: string }[] {
  return TROOP_TYPES.flatMap((type) => {
    const entry = troops[type];
    const level = entry.level.trim();
    return [
      ...(level ? [{ metric: `troop_level_${type}`, value: level }] : []),
      { metric: `helios_${type}`, value: entry.helios ? "yes" : "no" },
    ];
  });
}

/** The form's starting state: what this account last reported. */
export function troopDraftFrom(current: Record<string, { value: number | string } | undefined>): TroopDraft {
  return Object.fromEntries(
    TROOP_TYPES.map((type) => [
      type,
      {
        level: String(current[`troop_level_${type}`]?.value ?? ""),
        helios: current[`helios_${type}`]?.value === "yes",
      },
    ]),
  ) as TroopDraft;
}
