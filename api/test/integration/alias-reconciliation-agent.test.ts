import { afterAll, beforeAll, describe, expect, it } from "vitest";
import aliasFixture from "../fixtures/POPHQ-confirmed-aliases-fixture.json" with { type: "json" };
import type { Group } from "../../src/domain/principal.js";
import { createHarness, type Harness } from "./harness.js";

describe("guarded operational alias reconciliation", () => {
  let h: Harness;
  let token: string;
  let readOnlyToken: string;
  let issuerGroups = new Set<Group>(["player", "officer"]);
  const actor = { id: "fixture", via: "seed" as const };

  beforeAll(async () => {
    h = await createHarness({ botIssuerGroups: async (issuedBy) => issuedBy === "alias-officer" ? issuerGroups : undefined });
    await h.repo.createAccount({ playerId: "740000001", name: "Alias Officer", alliance: "POP", rank: "R4", status: "active" }, actor);
    await h.repo.linkAccount("alias-officer", "740000001", actor);
    await h.repo.createAccount({ playerId: "740000002", name: "Wenzy", alliance: "POP", rank: "R3", status: "active", note: "unchanged" }, actor);
    await h.repo.createAccount({ playerId: "740000003", name: "Arya Stark", alliance: "POP", rank: "R4", status: "active" }, actor);
    await h.repo.linkAccount("arya-login", "740000003", actor);
    await h.repo.createAccount({ playerId: "740000004", name: "Other Player", alliance: "POP", status: "active" }, actor);
    const issued = await h.call("POST", "/agent-tokens", { as: "alias-officer", groups: ["officer"], body: { name: "Alias bot", scopes: ["all:read", "accounts:write"], expiresInDays: 30 } });
    token = issued.body.token as string;
    const readOnly = await h.call("POST", "/agent-tokens", { as: "alias-officer", groups: ["officer"], body: { name: "Read only", scopes: ["all:read"], expiresInDays: 30 } });
    readOnlyToken = readOnly.body.token as string;
  });

  afterAll(() => h.cleanup());

  const agent = (body?: unknown, headers: Record<string, string> = {}, selectedToken = token) => ({ body, headers: { authorization: `Bearer ${selectedToken}`, ...headers } });
  const source = (reference: string) => ({ kind: "owner_confirmation", reference, note: "Owner confirmed the same exact game account." });
  const batch = (batchId: string, entries: unknown[]) => ({ batchId, alliance: "POP", entries });

  it("previews, atomically applies and resolves aliases without changing account identity", async () => {
    const before = await h.repo.getAccount("740000002");
    const body = batch("confirmed-aliases", [{
      sourceId: "wenzy-confirmed",
      playerId: "740000002",
      name: "Wenzy",
      aliases: [
        { name: "Wenzyporsche", source: source("TRAX-545/owner-confirmation.json") },
        { name: " wenzy ", source: source("TRAX-545/cosmetic-confirmation.json") },
        { name: "Wenzyporsche", source: source("TRAX-545/second-confirmation.json") },
      ],
    }]);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(body));
    expect(preview).toMatchObject({
      status: 200,
      body: {
        dryRun: true,
        applicable: true,
        counts: { aliasesToAdd: 1, aliasesAlreadyPresent: 1, cosmeticAliasNoops: 1, aliasConflicts: 0, evidenceToAdd: 3 },
        effects: { createsLogin: false, changesMembership: false, writesScores: false },
      },
    });
    expect((preview.body.rows as Record<string, unknown>[])[0]).toMatchObject({
      before,
      after: before,
      existingAliases: [],
      aliasAdditions: ["Wenzyporsche"],
      aliasReviews: [
        { name: "Wenzyporsche", decision: "add_alias", conflictingPlayerIds: [] },
        { name: "wenzy", decision: "already_resolves_cosmetically", conflictingPlayerIds: [] },
        { name: "Wenzyporsche", decision: "already_present", conflictingPlayerIds: [] },
      ],
    });
    expect(await h.repo.listAliases("740000002")).toEqual([]);

    const approved = { ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Reviewed confirmed alias sources" };
    const applied = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(approved, { "idempotency-key": "confirmed-aliases-v1" }));
    expect(applied).toMatchObject({ status: 201, body: { dryRun: false, replayed: false, counts: { aliasesToAdd: 1 } } });
    expect(await h.repo.getAccount("740000002")).toEqual(before);
    expect(await h.repo.listAliases("740000002")).toEqual([expect.objectContaining({ name: "Wenzyporsche" })]);

    const readback = await h.call("GET", "/agent/accounts/740000002/reconciliation", agent());
    expect(readback).toMatchObject({ status: 200, body: { account: before, hasLogin: false, aliases: [expect.objectContaining({ name: "Wenzyporsche" })] } });
    expect(readback.body.aliasSources).toHaveLength(3);
    const resolved = await h.call("GET", "/agent/accounts/resolve-name?name=Wenzyporsche", agent());
    expect(resolved).toMatchObject({ status: 200, body: { ambiguous: false, resolved: { playerId: "740000002", canonicalName: "Wenzy", basis: "alias" } } });

    const replay = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(approved, { "idempotency-key": "confirmed-aliases-v1" }));
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    const changedPayload = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...approved, reason: "Different request" }, { "idempotency-key": "confirmed-aliases-v1" }));
    expect(changedPayload.status).toBe(409);
  });

  it("supports login-linked targets and preserves additional provenance for an existing alias", async () => {
    await h.repo.addAlias("740000003", "Arya", "Existing verified alias", actor);
    const body = batch("arya-more-provenance", [{
      sourceId: "arya-owner-confirmation",
      playerId: "740000003",
      name: "Arya Stark",
      aliases: [{ name: "Arya", source: source("TRAX-539/owner-confirmations.json") }],
    }]);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(body));
    expect(preview.body).toMatchObject({ applicable: true, counts: { aliasesToAdd: 0, aliasesAlreadyPresent: 1, evidenceToAdd: 1 } });
    expect((preview.body.rows as Record<string, unknown>[])[0]).toMatchObject({ hasLogin: true, aliasReviews: [{ decision: "already_present" }] });
    const applied = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Reviewed additional alias provenance" }, { "idempotency-key": "arya-provenance-v1" }));
    expect(applied.status).toBe(201);
    expect(await h.repo.listAliases("740000003")).toHaveLength(1);
    expect((await h.call("GET", "/agent/accounts/740000003/reconciliation", agent())).body.aliasSources).toHaveLength(1);
  });

  it("blocks missing targets, cross-account claims, duplicate IDs and stale collision previews without partial writes", async () => {
    await h.repo.addAlias("740000004", "Claimed Name", "Verified existing claim", actor);
    const invalid = await h.call("POST", "/agent/accounts/reconcile", agent(batch("blocked-aliases", [
      { sourceId: "missing", playerId: "749999999", name: "Missing", aliases: [{ name: "Missing Alias", source: source("missing.json") }] },
      { sourceId: "collision", playerId: "740000002", name: "Wenzy", aliases: [{ name: "Claimed Name", source: source("collision.json") }] },
      { sourceId: "duplicate-a", playerId: "740000003", name: "Arya Stark", aliases: [{ name: "One", source: source("one.json") }] },
      { sourceId: "duplicate-b", playerId: "740000003", name: "Arya Stark", aliases: [{ name: "Two", source: source("two.json") }] },
    ])));
    expect(invalid.body).toMatchObject({ applicable: false, counts: { conflicts: 4, aliasConflicts: 2 } });
    const invalidRows = invalid.body.rows as { aliasReviews: Record<string, unknown>[] }[];
    expect(invalidRows[0]!.aliasReviews[0]).toMatchObject({ decision: "invalid_source" });
    expect(invalidRows[1]!.aliasReviews[0]).toMatchObject({ decision: "conflict", conflictingPlayerIds: ["740000004"] });
    expect(await h.repo.listAliases("740000002")).toHaveLength(1);

    const raceBody = batch("race-preview", [{ sourceId: "race", playerId: "740000002", name: "Wenzy", aliases: [{ name: "Race Name", source: source("race.json") }] }]);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(raceBody));
    expect(preview.body.applicable).toBe(true);
    await h.repo.addAlias("740000004", "Race Name", "Claim appeared after preview", actor);
    const raced = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...raceBody, expectedHash: preview.body.expectedHash, approved: true, reason: "Stale reviewed preview" }, { "idempotency-key": "race-preview-v1" }));
    expect(raced.status).toBe(409);
    expect((await h.repo.listAliases("740000002")).map((alias) => alias.name)).not.toContain("Race Name");
    expect((await h.repo.listHistoricalRecords("alias")).filter((record) => record.sourceId === "race")).toEqual([]);
  });

  it("allows only one of two concurrent cross-account claims and leaves no partial loser evidence", async () => {
    const first = batch("concurrent-first", [{ sourceId: "concurrent-first", playerId: "740000002", name: "Wenzy", aliases: [{ name: "Concurrent Claim", source: source("first.json") }] }]);
    const second = batch("concurrent-second", [{ sourceId: "concurrent-second", playerId: "740000003", name: "Arya Stark", aliases: [{ name: "Concurrent Claim", source: source("second.json") }] }]);
    const [firstPreview, secondPreview] = await Promise.all([
      h.call("POST", "/agent/accounts/reconcile", agent(first)),
      h.call("POST", "/agent/accounts/reconcile", agent(second)),
    ]);
    expect(firstPreview.body.applicable).toBe(true);
    expect(secondPreview.body.applicable).toBe(true);
    const outcomes = await Promise.all([
      h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...first, expectedHash: firstPreview.body.expectedHash, approved: true, reason: "Concurrent claim test one" }, { "idempotency-key": "concurrent-claim-one" })),
      h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...second, expectedHash: secondPreview.body.expectedHash, approved: true, reason: "Concurrent claim test two" }, { "idempotency-key": "concurrent-claim-two" })),
    ]);
    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual([201, 409]);
    const owners = await Promise.all(["740000002", "740000003"].map(async (id) => ({ id, aliases: (await h.repo.listAliases(id)).map((alias) => alias.name) })));
    expect(owners.filter((owner) => owner.aliases.includes("Concurrent Claim"))).toHaveLength(1);
    const evidence = (await h.repo.listHistoricalRecords("alias")).filter((record) => record.sourceId.startsWith("concurrent-"));
    expect(evidence).toHaveLength(1);
  });

  it("validates provenance and authorization and keeps matching exact rather than fuzzy", async () => {
    const entry = { sourceId: "auth", playerId: "740000002", name: "Wenzy", aliases: [{ name: "Wenzy99", source: source("auth.json") }] };
    const body = batch("auth-alias", [entry]);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body, {}, readOnlyToken))).status).toBe(403);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent({ ...body, entries: [{ ...entry, aliases: [{ name: "X", source: { kind: "invented", reference: "x" } }] }] }))).status).toBe(400);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent({ ...body, entries: [{ ...entry, playerId: "bad-id" }] }))).status).toBe(400);
    const fuzzy = await h.call("GET", "/agent/accounts/resolve-name?name=WenzyJr", agent());
    expect(fuzzy).toMatchObject({ status: 200, body: { resolved: null, matches: [], ambiguous: false } });
    issuerGroups = new Set<Group>(["player"]);
    const officer = await h.repo.getAccount("740000001");
    await h.repo.updateAccount({ ...officer!, rank: "R3" }, actor);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body))).status).toBe(403);
    issuerGroups = new Set<Group>(["player", "officer"]);
    await h.repo.updateAccount({ ...officer!, rank: "R4" }, actor);
  });

  it("accounts for and applies all 13 reviewed fixture rows while preserving existing aliases", async () => {
    const fixtureHarness = await createHarness({ botIssuerGroups: async (issuedBy) => issuedBy === "fixture-officer" ? new Set<Group>(["player", "officer"]) : undefined });
    try {
      await fixtureHarness.repo.createAccount({ playerId: "799000001", name: "Fixture Officer", alliance: "POP", rank: "R4", status: "active" }, actor);
      await fixtureHarness.repo.linkAccount("fixture-officer", "799000001", actor);
      const issued = await fixtureHarness.call("POST", "/agent-tokens", { as: "fixture-officer", groups: ["officer"], body: { name: "Fixture alias bot", scopes: ["all:read", "accounts:write"], expiresInDays: 1 } });
      const fixtureToken = issued.body.token as string;
      const fixtureAgent = (body?: unknown, headers: Record<string, string> = {}) => ({ body, headers: { authorization: `Bearer ${fixtureToken}`, ...headers } });
      for (const entry of aliasFixture.entries) {
        await fixtureHarness.repo.createAccount({ playerId: entry.playerId, name: entry.name, alliance: "POP", status: "unknown" }, actor);
      }
      await fixtureHarness.repo.createAccount({ playerId: "390464931", name: "POPs Creature", alliance: "POP", status: "unknown" }, actor);
      await fixtureHarness.repo.addAlias("399036497", "Kox", "Existing alias must survive", actor);
      await fixtureHarness.repo.addAlias("390464931", "Shadow Creature", "Existing alias must survive", actor);
      const body = { ...aliasFixture, batchId: "confirmed-alias-fixture" };
      const preview = await fixtureHarness.call("POST", "/agent/accounts/reconcile", fixtureAgent(body));
      expect(preview).toMatchObject({
        status: 200,
        body: {
          dryRun: true,
          applicable: true,
          counts: { reuse: 13, conflicts: 0, aliasesToAdd: 11, cosmeticAliasNoops: 2, aliasConflicts: 0, evidenceToAdd: 13 },
          transactionOperations: 60,
        },
      });
      expect(preview.body.rows).toHaveLength(13);
      const applied = await fixtureHarness.call("POST", "/agent/accounts/reconcile?apply=true", fixtureAgent({
        ...body,
        expectedHash: preview.body.expectedHash,
        approved: true,
        reason: "Isolated fixture acceptance test",
      }, { "idempotency-key": "confirmed-alias-fixture-v1" }));
      expect(applied.status).toBe(201);
      expect((await fixtureHarness.repo.listAliases("399036497")).map((alias) => alias.name)).toEqual(expect.arrayContaining(["Kox", "Bad Dudu"]));
      expect((await fixtureHarness.repo.listAliases("390464931")).map((alias) => alias.name)).toEqual(["Shadow Creature"]);
      expect((await fixtureHarness.call("GET", "/agent/accounts/resolve-name?name=Wenzyporsche", fixtureAgent())).body.resolved).toMatchObject({ playerId: "401250554", basis: "alias" });
      expect(await fixtureHarness.repo.getAccount("401250554")).toMatchObject({ name: "Wenzy", status: "unknown" });
    } finally {
      await fixtureHarness.cleanup();
    }
  });
});
