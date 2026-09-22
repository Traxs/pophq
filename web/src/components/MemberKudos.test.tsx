import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberKudosCard } from "./MemberKudos";

describe("MemberKudosCard", () => {
  it("shows the current calculation, correction, expiry, and historical record", () => {
    const html = renderToStaticMarkup(<MemberKudosCard eligibility={{
      playerId: "P1", position: 7, totalMembers: 86, eligible: true, eligibleThrough: 40,
      score: .705, participationRate: .8, strength: 12500, strongestStrength: 20000,
      strengthShare: .625, kudosScore: 3.5, bestKudosScore: 7, kudosShare: .5,
      weights: { participation: .6, strength: .2, kudos: .2 },
      allocation: {
        source: "Phase 3", targetValueMin: 30_000, targetValueMax: 40_000,
        assignedValueMin: 27_500, assignedValueMax: 40_000, assignedUnvaluedUnits: 20,
      },
    }} summary={{
      score: 3.5,
      decayDays: 90,
      items: [
        {
          awardId: "K1", playerId: "P1", points: 10, reason: "Helped a new member",
          awardedAt: "2026-09-01T12:00:00.000Z", currentPoints: 5, remainingShare: .5,
          ageDays: 45, daysRemaining: 45, expiresAt: "2026-11-30T12:00:00.000Z", active: true,
        },
        {
          awardId: "K2", playerId: "P1", points: -3, reason: "Duplicate award correction",
          awardedAt: "2026-09-20T12:00:00.000Z", currentPoints: -1.5, remainingShare: .5,
          ageDays: 45, daysRemaining: 45, expiresAt: "2026-12-19T12:00:00.000Z", active: true,
        },
        {
          awardId: "K3", playerId: "P1", points: 4, reason: "Old contribution",
          awardedAt: "2026-01-01T12:00:00.000Z", currentPoints: 0, remainingShare: 0,
          ageDays: 200, daysRemaining: 0, expiresAt: "2026-04-01T12:00:00.000Z", active: false,
        },
      ],
    }} />);

    expect(html).toContain("Your kudos awards");
    expect(html).toContain("Fortress reward eligibility");
    expect(html).toContain("Eligible now");
    expect(html).toContain("#7");
    expect(html).toContain("of 86 active members");
    expect(html).toContain("Top 40 are eligible");
    expect(html).toContain("Your score-weighted target this cycle");
    expect(html).toContain("30,000–40,000 Gems");
    expect(html).toContain("20 unvalued");
    expect(html).toContain("Overall score");
    expect(html).toContain("70.5");
    expect(html).toContain("/ 100 pts");
    expect(html).toContain("Input 80%");
    expect(html).toContain("worth up to 60 pts");
    expect(html).toContain("48 pts");
    expect(html).toContain("12.5 pts");
    expect(html).toContain("10 pts");
    expect(html).toContain("48 + 12.5 + 10 =");
    expect(html.match(/class="eligibility-part"/g)).toHaveLength(3);
    expect(html).toContain("+3.5");
    expect(html).toContain("+5");
    expect(html).toContain("of +10");
    expect(html).toContain("-1.5");
    expect(html).toContain("45 days until it contributes 0");
    expect(html).toContain("Expired history (1)");
    expect(html).toContain("Old contribution");
  });
});
