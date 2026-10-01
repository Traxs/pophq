import { describe, expect, it } from "vitest";
import type { EventMember } from "./api";
import { latestKnown, sortForBreakdown, totalsOf } from "./eventBreakdown";

const member = (over: Partial<EventMember> & { name: string }): EventMember => ({
  playerId: `10000000${over.name.length}`,
  rank: null,
  answer: null,
  sessionId: null,
  answeredAt: null,
  attended: null,
  lineup: null,
  strengthTrend: [],
  attendanceTrend: [],
  power: null,
  foundryStrength: null,
  furnace: null,
  lastReportAt: null,
  ...over,
});

describe("latestKnown", () => {
  it("takes the most recent month that has a reading", () => {
    expect(latestKnown([0.2, 0.5, null, null])).toBe(0.5);
    expect(latestKnown([null, null, 0.9])).toBe(0.9);
  });

  it("is undefined when nothing was ever recorded, which is not zero", () => {
    expect(latestKnown([])).toBeUndefined();
    expect(latestKnown([null, null])).toBeUndefined();
  });

  it("keeps a real zero", () => {
    expect(latestKnown([0.4, 0])).toBe(0);
  });
});

describe("sortForBreakdown", () => {
  it("puts R5 through R1 first, then sorts by Foundry strength within each rank", () => {
    const rows = sortForBreakdown(
      [
        member({ name: "Strong R3", rank: "R3", foundryStrength: 900 }),
        member({ name: "Small R4", rank: "R4", foundryStrength: 10 }),
        member({ name: "Big R4", rank: "R4", foundryStrength: 90 }),
        member({ name: "R5", rank: "R5", foundryStrength: 1 }),
        member({ name: "R2", rank: "R2", foundryStrength: 999 }),
      ],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["R5", "Big R4", "Small R4", "Strong R3", "R2"]);
  });

  it("sorts Canyon-style groups by city power within each rank", () => {
    const rows = sortForBreakdown(
      [
        // Strong in the Foundry but small overall: the order has to follow the metric on screen.
        member({ name: "Specialist", rank: "R3", foundryStrength: 900, power: 10 }),
        member({ name: "Whale", rank: "R3", foundryStrength: 1, power: 900 }),
      ],
      "power",
    );
    expect(rows.map((m) => m.name)).toEqual(["Whale", "Specialist"]);
  });

  it("puts people without a reading last rather than treating them as zero", () => {
    const rows = sortForBreakdown(
      [member({ name: "Unknown", rank: "R3" }), member({ name: "Weak", rank: "R3", foundryStrength: 1 })],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["Weak", "Unknown"]);
  });

  it("puts members without an alliance rank after ranked members", () => {
    const rows = sortForBreakdown(
      [
        member({ name: "Unranked whale", foundryStrength: 999 }),
        member({ name: "Ranked", rank: "R1", foundryStrength: 1 }),
      ],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["Ranked", "Unranked whale"]);
  });

  it("breaks ties by name, so the order does not wobble", () => {
    const rows = sortForBreakdown(
      [member({ name: "Zeta", rank: "R3", foundryStrength: 50 }), member({ name: "Alpha", rank: "R3", foundryStrength: 50 })],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("does not disturb the array it was given", () => {
    const input = [member({ name: "A", rank: "R2", foundryStrength: 1 }), member({ name: "B", rank: "R3", foundryStrength: 9 })];
    sortForBreakdown(input, "foundry");
    expect(input.map((m) => m.name)).toEqual(["A", "B"]);
  });
});

describe("totalsOf", () => {
  it("adds up the group and says how much of it is unknown", () => {
    const group = [
      member({ name: "A", foundryStrength: 100, power: 5 }),
      member({ name: "B", foundryStrength: 50, power: 5 }),
      member({ name: "C" }),
    ];
    expect(totalsOf(group, "foundry")).toEqual({ people: 3, strength: 150, missing: 1 });
    expect(totalsOf(group, "power")).toEqual({ people: 3, strength: 10, missing: 1 });
  });

  it("is empty for an empty group", () => {
    expect(totalsOf([], "foundry")).toEqual({ people: 0, strength: 0, missing: 0 });
  });
});
