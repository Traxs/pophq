import { describe, expect, it } from "vitest";
import { troopDraftFrom, troopValues, type TroopDraft } from "./troops";

const draft = (over: Partial<TroopDraft> = {}): TroopDraft => ({
  infantry: { level: "", helios: false },
  lancer: { level: "", helios: false },
  marksman: { level: "", helios: false },
  ...over,
});

describe("troopValues", () => {
  it("lets every troop type hold Helios at once", () => {
    const values = troopValues(
      draft({
        infantry: { level: "FC9", helios: true },
        lancer: { level: "FC9", helios: true },
        marksman: { level: "FC9", helios: true },
      }),
    );
    expect(values.filter((v) => v.metric.startsWith("helios_")).every((v) => v.value === "yes")).toBe(true);
    expect(values).toHaveLength(6);
  });

  it("sends the no as well, so an upgrade can be unticked again", () => {
    // The bug this guards: sending only the ticks left the previous report's "yes" standing as
    // the current value, and Helios could never be turned off.
    const values = troopValues(draft({ infantry: { level: "FC9", helios: false } }));
    expect(values).toContainEqual({ metric: "helios_infantry", value: "no" });
  });

  it("keeps each type's level with its own type", () => {
    const values = troopValues(
      draft({
        infantry: { level: "FC10", helios: true },
        marksman: { level: "28", helios: false },
      }),
    );
    expect(values).toContainEqual({ metric: "troop_level_infantry", value: "FC10" });
    expect(values).toContainEqual({ metric: "troop_level_marksman", value: "28" });
    expect(values).toContainEqual({ metric: "helios_marksman", value: "no" });
  });

  it("leaves out a level nobody filled in, which is not a level of nothing", () => {
    const values = troopValues(draft({ lancer: { level: "   ", helios: true } }));
    expect(values.some((v) => v.metric.startsWith("troop_level_"))).toBe(false);
    expect(values).toContainEqual({ metric: "helios_lancer", value: "yes" });
  });

  it("trims what was typed", () => {
    expect(troopValues(draft({ infantry: { level: " FC9 ", helios: false } }))).toContainEqual({
      metric: "troop_level_infantry",
      value: "FC9",
    });
  });
});

describe("troopDraftFrom", () => {
  it("starts from what this account last reported", () => {
    const d = troopDraftFrom({
      troop_level_infantry: { value: "FC9" },
      helios_infantry: { value: "yes" },
      helios_lancer: { value: "no" },
    });
    expect(d.infantry).toEqual({ level: "FC9", helios: true });
    expect(d.lancer).toEqual({ level: "", helios: false });
    expect(d.marksman).toEqual({ level: "", helios: false });
  });

  it("treats anything that is not a yes as not held", () => {
    expect(troopDraftFrom({ helios_marksman: { value: "unknown" } }).marksman.helios).toBe(false);
    expect(troopDraftFrom({}).marksman.helios).toBe(false);
  });
});
