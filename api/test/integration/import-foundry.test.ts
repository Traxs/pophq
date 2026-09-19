import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyImport, planImport, type BundleObservation, type BundlePlayer } from "../../src/ops/importFoundry.js";
import { createHarness, type Harness } from "./harness.js";

const actor = { id: "import-test", via: "migration" as const, reason: "bundle import" };

// Invented people; real member data never belongs in this repository.
const players: BundlePlayer[] = [
  { id: "uuid-1", canonical_name: "Frostbite", game_player_id: "710000001" },
  { id: "uuid-2", canonical_name: "Blizzard", game_player_id: "710000002" },
];
const observations: BundleObservation[] = [
  { id: "o1", player_id: "uuid-1", metric: "combat_power", value: 8726, observed_at: "2026-09-06", precision: "date" },
  { id: "o2", player_id: "uuid-1", metric: "combat_power", value: 9100, observed_at: "2026-09-17", precision: "date" },
  { id: "o3", player_id: "uuid-2", metric: "combat_power", value: 5000, observed_at: "2026-09-06", precision: "date" },
];

describe("importing a bundle", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.cleanup());

  it("creates accounts with unknown membership and stores the observations", async () => {
    const result = await applyImport(h.repo, planImport(players, observations), actor);
    expect(result).toMatchObject({ accountsCreated: 2, accountsKept: 0, reportsWritten: 3, reportsAlreadyThere: 0 });

    const account = await h.repo.getAccount("710000001");
    expect(account).toMatchObject({ name: "Frostbite", alliance: "POP", status: "unknown" });

    const reports = await h.repo.listReports("710000001");
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ source: "import" });
    expect(reports.map((r) => r.values[0]?.metric)).toEqual(["foundry_strength", "foundry_strength"]);
    expect(reports.map((r) => r.values[0]?.precision)).toEqual(["date", "date"]);
  });

  it("changes nothing when the same bundle is imported again", async () => {
    const again = await applyImport(h.repo, planImport(players, observations), actor);
    expect(again).toMatchObject({ accountsCreated: 0, accountsKept: 2, reportsWritten: 0, reportsAlreadyThere: 3 });
    expect(await h.repo.listReports("710000001")).toHaveLength(2);
  });

  it("never renames an account POP HQ already knows", async () => {
    await h.repo.createAccount(
      { playerId: "710000003", name: "TheirRealName", alliance: "POP", rank: "R4", status: "active" },
      actor,
    );
    const renamed: BundlePlayer[] = [{ id: "uuid-3", canonical_name: "OldNameFromBundle", game_player_id: "710000003" }];
    await applyImport(h.repo, planImport(renamed, []), actor);
    expect(await h.repo.getAccount("710000003")).toMatchObject({ name: "TheirRealName", rank: "R4", status: "active" });
  });

  it("feeds the charts: an imported account has a strength series", async () => {
    // Imported accounts have unknown membership, so they appear with cohort=all.
    const res = await h.call("GET", "/metrics/alliance?metric=foundry_strength&weeks=4&cohort=all", {
      as: "officer",
      groups: ["officer"],
    });
    const body = res.body as {
      points: { total: number; members: number }[];
      gainers: { name: string; percent: number }[];
      unknownMembership: number;
    };
    expect(body.unknownMembership).toBeGreaterThanOrEqual(2);
    expect(body.points.at(-1)!.members).toBeGreaterThanOrEqual(2);
    expect(body.gainers.find((g) => g.name === "Frostbite")).toMatchObject({ from: 8726, to: 9100 });
  });
});
