import { describe, expect, it } from "vitest";
import { planImport, type BundleObservation, type BundlePlayer } from "./importFoundry.js";

// Invented people: real member data never belongs in this public repository.
const players: BundlePlayer[] = [
  { id: "uuid-1", canonical_name: "Frostbite", display_name: "Frosty", game_player_id: "410691488" },
  { id: "uuid-2", canonical_name: "Blizzard", game_player_id: null },
  { id: "uuid-3", canonical_name: "Icicle", game_player_id: "not-a-number" },
  { id: "uuid-4", canonical_name: "", game_player_id: "123456789" },
];

const observation = (over: Partial<BundleObservation> & { id: string; player_id: string }): BundleObservation => ({
  metric: "combat_power",
  unit: "score",
  value: 8726,
  observed_at: "2026-09-06",
  precision: "date",
  recorded_at: "2026-09-06T08:59:49.471191+00:00",
  source_type: "owner_reported",
  review_status: "verified",
  evidence_id: null,
  ...over,
});

describe("planImport", () => {
  const plan = planImport(players, [
    observation({ id: "obs-1", player_id: "uuid-1" }),
    observation({ id: "obs-2", player_id: "uuid-1", observed_at: "2026-09-17", value: 9100, evidence_id: "ev-9" }),
    observation({ id: "obs-3", player_id: "uuid-2" }), // no Player ID
    observation({ id: "obs-4", player_id: "uuid-1", metric: "mystery_power" }),
    observation({ id: "obs-5", player_id: "uuid-1", value: Number.NaN }),
  ]);

  it("takes only accounts with a usable Player ID and name", () => {
    expect(plan.accounts).toEqual([{ playerId: "410691488", name: "Frostbite", bundleId: "uuid-1" }]);
    expect(plan.withoutPlayerId).toEqual([{ bundleId: "uuid-2", name: "Blizzard" }]);
    expect(plan.skipped.map((s) => s.id)).toContain("uuid-3"); // invalid Player ID
    expect(plan.skipped.map((s) => s.id)).toContain("uuid-4"); // unusable name
  });

  it("maps Hermes' combat_power to foundry strength and keeps its date and source", () => {
    const [first, second] = plan.reports;
    expect(first).toMatchObject({
      reportId: "IMPORT-obs-1",
      playerId: "410691488",
      metric: "foundry_strength",
      value: 8726,
      effectiveAt: "2026-09-06T00:00:00.000Z",
      recordedAt: "2026-09-06T08:59:49.471191+00:00",
      precision: "date",
    });
    expect(first?.note).toContain("owner_reported");
    expect(second?.note).toContain("evidence ev-9");
  });

  it("reports what it could not use instead of guessing", () => {
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.id, s.reason]));
    expect(reasons["obs-3"]).toBe("no account with a Player ID");
    expect(reasons["obs-4"]).toContain("unknown metric");
    expect(reasons["obs-5"]).toContain("not a number");
    expect(plan.reports.map((r) => r.reportId)).toEqual(["IMPORT-obs-1", "IMPORT-obs-2"]);
  });

  it("gives the same plan for the same bundle, so importing twice is safe", () => {
    const again = planImport(players, [observation({ id: "obs-1", player_id: "uuid-1" })]);
    expect(again.reports[0]?.reportId).toBe("IMPORT-obs-1");
  });
});
