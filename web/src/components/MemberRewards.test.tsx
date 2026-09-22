import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentRewardCycle, MemberRewardAssignment } from "../api";
import { MemberRewardCards } from "./MemberRewards";

describe("MemberRewardCards", () => {
  it("shows dummy assignment details and the frozen reason for eligibility", () => {
    const assignment: MemberRewardAssignment = {
      poolId: "health-pool",
      playerId: "100000001",
      name: "Poppy",
      amount: 20,
      assignedAt: "2026-09-22T18:14:00.000Z",
      assignedBy: "officer",
      status: "recommended",
      eligibility: {
        position: 7,
        eligibleThrough: 40,
        score: 0.747,
        participationRate: 0.8,
        strength: 14_500,
        strongestStrength: 20_000,
        strengthShare: 0.725,
        kudosShare: 0.61,
        weights: { participation: 0.6, strength: 0.2, kudos: 0.2 },
      },
      pool: {
        poolId: "health-pool",
        batchId: "phase-3",
        alliance: "POP",
        buff: "health",
        quantity: 60,
        remaining: 40,
        source: "Fortress battle phase 3",
        acquiredAt: "2026-09-22T17:00:00.000Z",
        createdBy: "officer",
        gemValuation: { min: 20_000, max: 20_000, confidence: "medium", basis: "City Bonus" },
      },
    };

    const cycle: CurrentRewardCycle = {
      source: "Fortress battle phase 3",
      acquiredAt: "2026-09-22T17:00:00.000Z",
      items: [assignment],
    };
    const html = renderToStaticMarkup(<MemberRewardCards cycle={cycle} onAllRewards={() => undefined} />);
    expect(html).toContain("Your reward plan");
    expect(html).toContain("Recommended and reserved from Fortress battle phase 3");
    expect(html).toContain("Nothing is confirmed delivered yet");
    expect(html).toContain("Recommended · reserved");
    expect(html).toContain("Troops Health Up II (12hrs)");
    expect(html).toContain("×20");
    expect(html).toContain("400,000 Gems");
    expect(html).toContain("Why this reward is recommended for you");
    expect(html).toContain("Place #7");
    expect(html).toContain("eligible places were 1–40");
    expect(html).toContain("Participation × 60% = 48 pts");
    expect(html).toContain("Strength × 20% = 14.5 pts");
    expect(html).toContain("Kudos × 20% = 12.2 pts");
    expect(html).toContain("14,500");
    expect(html).toContain("20,000");
  });
});
