import { describe, expect, it } from "vitest";
import type { EventMember } from "./api";
import { missingMemberTroopDetails, missingSvsTroopDetails, svsTroopRequestMessage } from "./svsTroops";

describe("SvS troop readiness", () => {
  it("requires an explicit Helios yes or no for every troop type", () => {
    expect(missingSvsTroopDetails({
      furnace_level: { metric: "furnace_level", value: "FC9", unit: "level", effectiveAt: "2026-10-01T00:00:00Z" },
      troop_level_infantry: { metric: "troop_level_infantry", value: "FC9", unit: "level", effectiveAt: "2026-10-01T00:00:00Z" },
      helios_infantry: { metric: "helios_infantry", value: "no", unit: "yes/no", effectiveAt: "2026-10-01T00:00:00Z" },
    })).toEqual(["Lancer FC", "Lancer Helios", "Marksman FC", "Marksman Helios"]);
  });

  it("distinguishes no Helios from unknown Helios", () => {
    const member = {
      furnace: "FC9",
      troops: {
        infantry: { level: "FC9", helios: false },
        lancer: { level: "FC8", helios: true },
        marksman: { level: "FC8", helios: null },
      },
    } as EventMember;
    expect(missingMemberTroopDetails(member)).toEqual(["Marksman Helios"]);
  });

  it("builds a reusable in-game request with a direct update link", () => {
    const message = svsTroopRequestMessage("https://pophq.fyi/power?update=1");
    expect(message).toContain("Infantry FC level + Helios");
    expect(message).toContain("https://pophq.fyi/power?update=1");
  });
});
