import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyEventImport,
  applyImport,
  planEventImport,
  planImport,
  type BundleAttendance,
  type BundleEvent,
  type BundleObservation,
  type BundlePlayer,
  type BundleSignup,
} from "../../src/ops/importFoundry.js";
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

describe("importing events, attendance and sign-ups", () => {
  // Invented people and dates; real member data never belongs in this repository.
  const players: BundlePlayer[] = [
    { id: "u1", canonical_name: "Frostbite", game_player_id: "720000001" },
    { id: "u2", canonical_name: "Blizzard", game_player_id: "720000002" },
    { id: "u3", canonical_name: "NoId", game_player_id: null },
  ];
  const events: BundleEvent[] = [
    { id: "e-l1", event_type: "foundry", event_date: "2026-09-06", legion: 1, time_utc: "12:00", status: "completed" },
    { id: "e-l2", event_type: "foundry", event_date: "2026-09-06", legion: 2, time_utc: "19:00", status: "completed" },
  ];
  const attendance: BundleAttendance[] = [
    { id: "a1", event_id: "e-l1", player_id: "u1", status: "present", source_type: "screenshot_extracted", evidence_id: "shot-1", updated_at: "2026-09-06T14:00:00Z" },
    { id: "a2", event_id: "e-l2", player_id: "u2", status: "absent", source_type: "owner_reported", updated_at: "2026-09-06T21:00:00Z" },
    { id: "a3", event_id: "e-l1", player_id: "u3", status: "present", updated_at: "2026-09-06T14:00:00Z" },
    { id: "a4", event_id: "unknown-event", player_id: "u1", status: "present", updated_at: "2026-09-06T14:00:00Z" },
  ];

  it("makes one event per day with a part per legion, and stores the attendance", async () => {
    const h = await createHarness();
    const plan = planEventImport(players, events, attendance, []);
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventId: "IMPORT-foundry-2026-09-06",
      title: "Foundry",
      startsAt: "2026-09-06T12:00:00.000Z",
      deadlineAt: "2026-09-03T23:59:59.999Z", // three days before, end of day
    });
    expect(plan.events[0]!.sessions.map((s) => `${s.id} ${s.startsAt} ${s.starters}+${s.subs}`)).toEqual([
      "L1 2026-09-06T12:00:00.000Z 30+10",
      "L2 2026-09-06T19:00:00.000Z 30+10",
    ]);
    expect(plan.attendance).toHaveLength(2); // the unknown player and unknown event are skipped
    expect(plan.skipped.map((s) => s.id).toSorted()).toEqual(["a3", "a4"]);

    const result = await applyEventImport(h.repo, plan, { id: "import", via: "migration" });
    expect(result).toMatchObject({ eventsCreated: 1, attendanceWritten: 2 });

    const stored = await h.repo.listAttendance("IMPORT-foundry-2026-09-06");
    expect(stored.find((a) => a.playerId === "720000001")).toMatchObject({
      status: "present",
      source: "screenshot",
      sessionId: "L1",
      evidenceRef: "shot-1",
      recordedAt: "2026-09-06T14:00:00Z", // the moment it was recorded, not the import time
    });
    expect(stored.find((a) => a.playerId === "720000002")).toMatchObject({ status: "absent", source: "officer" });

    // Reliability now reflects real history.
    await h.repo.createAccount({ playerId: "720000001", name: "Frostbite", alliance: "POP", status: "unknown" }, { id: "t", via: "migration" });
    const reliability = await h.call("GET", "/accounts/720000001/reliability", { as: "officer", groups: ["officer"] });
    expect(reliability.body).toMatchObject({ kept: 1, missed: 0, rate: 1, sample: 1 });

    // Importing the same bundle again changes nothing.
    const again = await applyEventImport(h.repo, planEventImport(players, events, attendance, []), { id: "import", via: "migration" });
    expect(again).toMatchObject({ eventsCreated: 0, eventsKept: 1 });
    expect(await h.repo.listAttendance("IMPORT-foundry-2026-09-06")).toHaveLength(2);
    await h.cleanup();
  });

  it("refuses sign-ups for an event that already happened, and counts them", async () => {
    const h = await createHarness();
    const signUps: BundleSignup[] = [
      { id: "s1", player_id: "u1", event_id: "e-l1", preferred_legion: 1 },
      { id: "s2", player_id: "u3", event_id: "e-l1", preferred_legion: 2 }, // no Player ID
    ];
    const plan = planEventImport(players, events, [], signUps);
    expect(plan.signUps).toEqual([{ eventId: "IMPORT-foundry-2026-09-06", playerId: "720000001", sessionId: "L1" }]);

    const result = await applyEventImport(h.repo, plan, { id: "import", via: "migration" });
    expect(result).toMatchObject({ signUpsWritten: 0, signUpsRefused: 1 }); // the event is in the past
    await h.cleanup();
  });
});
