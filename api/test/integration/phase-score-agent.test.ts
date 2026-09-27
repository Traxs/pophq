import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../fixtures/KOI-castle-battle-scores-fixture.json" with { type: "json" };
import { parseNewAccount } from "../../src/domain/accounts.js";
import type { Group } from "../../src/domain/principal.js";
import { createHarness, type Harness } from "./harness.js";

type FixtureEntry = (typeof fixture.entries)[number];
const OFFICER = { as: "officer", groups: ["officer"] };

describe("guarded KOI phase-score API", () => {
  let h: Harness;
  let token: string;
  let issuerGroups = new Set<Group>(["player", "officer"]);
  const verified = fixture.entries.filter((row): row is FixtureEntry & { playerId: string } => row.identityStatus === "verified_registry" && row.playerId !== null);

  beforeAll(async () => {
    h = await createHarness({ botIssuerGroups: async (issuedBy) => issuedBy === "officer" ? issuerGroups : undefined });
    const actor = { id: "fixture", via: "seed" as const };
    await h.repo.createAccount(parseNewAccount({ playerId: "700000001", name: "Import Officer", rank: "R4" }), actor);
    await h.repo.linkAccount("officer", "700000001", actor);
    for (const row of verified) await h.repo.createAccount(parseNewAccount({ playerId: row.playerId, name: row.displayName }), actor);
    await h.repo.createEvent({
      eventId: fixture.eventId,
      alliance: "POP",
      kind: "koi",
      title: fixture.eventTitle,
      startsAt: fixture.eventStartsAt,
      deadlineAt: "2026-09-26T07:00:00.000Z",
      sessions: [
        { id: "full", label: "Full time", startsAt: fixture.eventStartsAt },
        { id: "first", label: "First half", startsAt: fixture.eventStartsAt },
        { id: "last", label: "Last half", startsAt: "2026-09-26T13:00:00.000Z" },
      ],
      createdBy: "fixture",
    }, actor);
    const issued = await h.call("POST", "/agent-tokens", { ...OFFICER, body: { name: "Phase score bot", scopes: ["all:read", "results:write"], expiresInDays: 30 } });
    token = issued.body.token as string;
  });

  afterAll(() => h.cleanup());

  const agent = (body?: unknown, headers: Record<string, string> = {}) => ({ body, headers: { authorization: `Bearer ${token}`, ...headers } });
  const payload = {
    expectedVersion: 0,
    coverage: "partial",
    playerPoints: verified.map((row) => ({
      playerId: row.playerId,
      points: row.points,
      provenance: { sourceName: row.sourceName, displayName: row.displayName },
    })),
    source: { type: "owner_report", reference: "KOI-castle-battle-scores-fixture.json" },
  };

  it("reconciles the supplied evidence exactly", () => {
    expect(fixture.entries).toHaveLength(39);
    expect(fixture.entries.reduce((sum, row) => sum + row.points, 0)).toBe(1_415_767_691);
    expect(verified).toHaveLength(32);
    expect(fixture.entries.filter((row) => row.identityStatus === "owner_id_not_in_result_registry")).toHaveLength(6);
    expect(fixture.entries.filter((row) => row.playerId === null)).toEqual([expect.objectContaining({ displayName: "LordGrim", points: 38_267_899 })]);
  });

  it("reports every unresolved account atomically and persists nothing", async () => {
    const allWithIds = fixture.entries.filter((row): row is FixtureEntry & { playerId: string } => row.playerId !== null);
    const result = await h.call("PUT", `/agent/events/${fixture.eventId}/phases/castle_battle/scores`, agent({
      ...payload,
      playerPoints: allWithIds.map((row) => ({ playerId: row.playerId, points: row.points, provenance: { sourceName: row.sourceName, displayName: row.displayName, ...(row.suppliedLabel ? { suppliedLabel: row.suppliedLabel } : {}) } })),
    }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ detail: { unresolved: expect.arrayContaining([
      { playerId: "668923807", reason: "Game account not found" },
      { playerId: "390464931", reason: "Game account not found" },
      { playerId: "401265045", reason: "Game account not found" },
      { playerId: "405715203", reason: "Game account not found" },
      { playerId: "411751650", reason: "Game account not found" },
      { playerId: "524625066", reason: "Game account not found" },
    ]) } });
    expect(await h.repo.getEventPhaseScores(fixture.eventId, "castle_battle")).toBeUndefined();
  });

  it("previews with no effects, then applies and safely replays the approved subset", async () => {
    const path = `/agent/events/${fixture.eventId}/phases/castle_battle/scores`;
    const testIdempotencyKey = "test-phase-score";
    const preview = await h.call("PUT", path, agent(payload));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      expectedHash: expect.any(String),
      version: 1,
      coverage: "partial",
      counts: { added: 32, changed: 0, unchanged: 0 },
      subtotals: { before: 0, after: verified.reduce((sum, row) => sum + row.points, 0) },
      diff: { before: [], after: expect.arrayContaining([expect.objectContaining({ playerId: "401250554", points: 91_473_892 })]) },
    });
    expect(await h.repo.getEventPhaseScores(fixture.eventId, "castle_battle")).toBeUndefined();

    expect((await h.call("PUT", `${path}?apply=true`, agent(payload, { "idempotency-key": testIdempotencyKey }))).status).toBe(400);
    const approved = { ...payload, expectedHash: preview.body.expectedHash, approved: true, reason: "Officer approved exact fixture subset" };
    const applied = await h.call("PUT", `${path}?apply=true`, agent(approved, { "idempotency-key": testIdempotencyKey }));
    expect(applied).toMatchObject({ status: 201, body: { dryRun: false, replayed: false, result: { version: 1 } } });
    const replay = await h.call("PUT", `${path}?apply=true`, agent(approved, { "idempotency-key": testIdempotencyKey }));
    expect(replay).toMatchObject({ status: 200, body: { dryRun: false, replayed: true, result: { version: 1 } } });
    const conflict = await h.call("PUT", `${path}?apply=true`, agent({ ...approved, reason: "Different request" }, { "idempotency-key": testIdempotencyKey }));
    expect(conflict.status).toBe(409);

    const context = await h.call("GET", `/agent/events/${fixture.eventId}/phases/castle_battle/score-context`, agent());
    expect(context.body).toMatchObject({ version: 1, coverage: "partial", scoredPlayers: 32, scores: expect.arrayContaining([expect.objectContaining({ playerId: "401250554", points: 91_473_892 })]) });
    expect((context.body.scores as unknown[])).toHaveLength(32);
    expect(await h.repo.getEventPhaseScores(fixture.eventId, "preparation")).toBeUndefined();
    expect(await h.repo.listResults(fixture.eventId)).toEqual([]);
    expect((await h.call("PUT", path, agent(payload))).status).toBe(409);
  });

  it("does not let a non-officer bot enumerate other players", async () => {
    issuerGroups = new Set<Group>(["player"]);
    const issuer = await h.repo.getAccount("700000001");
    await h.repo.updateAccount({ ...issuer!, rank: "R3" }, { id: "fixture", via: "seed" });
    const context = await h.call("GET", `/agent/events/${fixture.eventId}/phases/castle_battle/score-context`, agent());
    expect(context.status).toBe(200);
    expect(context.body.players).toBeUndefined();
    expect(context.body.scores).toEqual([]);
    expect((await h.call("PUT", `/agent/events/${fixture.eventId}/phases/castle_battle/scores`, agent({ ...payload, expectedVersion: 1 }))).status).toBe(403);
  });
});
