import { describe, expect, it } from "vitest";
import { allianceScoreText, playerScoreText, rankedAllianceScores } from "./resultDisplay";

describe("Canyon alliance score display", () => {
  it("preserves rounded source precision instead of presenting an exact number", () => {
    expect(allianceScoreText({
      allianceTag: "POP", allianceName: "POP", isOurAlliance: true, score: 515_000,
      precision: { kind: "rounded", display: "515.0K", roundedTo: 100 },
    })).toBe("≈ 515.0K");
  });

  it("formats exact totals and ranks all three alliances independently", () => {
    const rows = [
      { allianceTag: "SOA", allianceName: "SonsOfAnarchy", isOurAlliance: false, score: 486_816, precision: { kind: "exact" as const } },
      { allianceTag: "POP", allianceName: "POP", isOurAlliance: true, score: 550_591, precision: { kind: "exact" as const } },
      { allianceTag: "BOS", allianceName: "S", isOurAlliance: false, score: 487_805, precision: { kind: "exact" as const } },
    ];
    expect(rankedAllianceScores(rows).map((row) => row.allianceTag)).toEqual(["POP", "BOS", "SOA"]);
    expect(allianceScoreText(rows[1]!)).toBe("550,591");
  });

  it("keeps a rounded player score visibly approximate", () => {
    expect(playerScoreText({
      points: 515_000,
      precision: { kind: "rounded", display: "515.0K", roundedTo: 100 },
    })).toBe("≈ 515.0K");
    expect(playerScoreText({ points: 515_000 })).toBe("515,000");
  });
});
