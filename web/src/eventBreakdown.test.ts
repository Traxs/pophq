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
  it("puts the strongest first, so a short legion shows who matters", () => {
    const rows = sortForBreakdown(
      [
        member({ name: "Small", foundryStrength: 10 }),
        member({ name: "Big", foundryStrength: 90 }),
        member({ name: "Middle", foundryStrength: 50 }),
      ],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["Big", "Middle", "Small"]);
  });

  it("sorts by power for an event that is not a Foundry, which is the column it shows", () => {
    const rows = sortForBreakdown(
      [
        // Strong in the Foundry but small overall: the order has to follow the metric on screen.
        member({ name: "Specialist", foundryStrength: 900, power: 10 }),
        member({ name: "Whale", foundryStrength: 1, power: 900 }),
      ],
      "power",
    );
    expect(rows.map((m) => m.name)).toEqual(["Whale", "Specialist"]);
  });

  it("puts people without a reading last rather than treating them as zero", () => {
    const rows = sortForBreakdown([member({ name: "Unknown" }), member({ name: "Weak", foundryStrength: 1 })], "foundry");
    expect(rows.map((m) => m.name)).toEqual(["Weak", "Unknown"]);
  });

  it("breaks ties by name, so the order does not wobble", () => {
    const rows = sortForBreakdown(
      [member({ name: "Zeta", foundryStrength: 50 }), member({ name: "Alpha", foundryStrength: 50 })],
      "foundry",
    );
    expect(rows.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("does not disturb the array it was given", () => {
    const input = [member({ name: "A", foundryStrength: 1 }), member({ name: "B", foundryStrength: 9 })];
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
