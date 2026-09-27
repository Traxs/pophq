import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sevenFixture from "../fixtures/POPHQ-seven-shell-accounts-fixture.json" with { type: "json" };
import scoreFixture from "../fixtures/KOI-castle-battle-scores-fixture.json" with { type: "json" };
import type { Group } from "../../src/domain/principal.js";
import type { LoginDirectory } from "../../src/ops/invite.js";
import { createHarness, type Harness } from "./harness.js";

describe("guarded login-free account onboarding", () => {
  let h: Harness;
  let token: string;
  let tokenId: string;
  let readOnlyToken: string;
  let issuerGroups = new Set<Group>(["player", "officer"]);
  const loginCalls = { email: 0, password: 0, delete: 0 };
  const logins: LoginDirectory = {
    findSub: async () => undefined,
    createLogin: async () => { loginCalls.email += 1; return "unexpected"; },
    createPasswordLogin: async () => { loginCalls.password += 1; return { sub: "unexpected", username: "unexpected", password: "unexpected" }; },
    resetPassword: async () => ({ password: "unexpected" }),
    deleteLogin: async () => { loginCalls.delete += 1; },
  };
  const actor = { id: "fixture", via: "seed" as const };

  beforeAll(async () => {
    h = await createHarness({
      logins,
      botIssuerGroups: async (issuedBy) => issuedBy === "officer" ? issuerGroups : undefined,
    });
    await h.repo.createAccount({ playerId: "700000001", name: "Onboarding Officer", alliance: "POP", rank: "R4", status: "active" }, actor);
    await h.repo.linkAccount("officer", "700000001", actor);
    const issued = await h.call("POST", "/agent-tokens", {
      as: "officer",
      groups: ["officer"],
      body: { name: "Account onboarding bot", scopes: ["all:read", "accounts:write", "results:write"], expiresInDays: 30 },
    });
    token = issued.body.token as string;
    tokenId = issued.body.tokenId as string;
    const readOnly = await h.call("POST", "/agent-tokens", {
      as: "officer",
      groups: ["officer"],
      body: { name: "Read-only bot", scopes: ["all:read"], expiresInDays: 30 },
    });
    readOnlyToken = readOnly.body.token as string;
  });

  afterAll(() => h.cleanup());

  const agent = (body?: unknown, headers: Record<string, string> = {}, selectedToken = token) => ({
    body,
    headers: { authorization: `Bearer ${selectedToken}`, ...headers },
  });
  const batch = (batchId: string, entries: unknown = sevenFixture.entries) => ({
    ...sevenFixture,
    batchId,
    entries,
  });

  it("retains accounts:write through issuance, storage, doctor and a dry-run preview", async () => {
    expect(await h.repo.getAgentToken(tokenId)).toMatchObject({
      tokenId,
      scopes: ["all:read", "accounts:write", "results:write"],
    });
    expect(await h.call("GET", "/agent/doctor", agent())).toMatchObject({
      status: 200,
      body: { tokenId, scopes: ["all:read", "results:write", "accounts:write"] },
    });
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(batch("issuance-preview", [sevenFixture.entries[0]])));
    expect(preview).toMatchObject({
      status: 200,
      body: { dryRun: true, applicable: true, counts: { create: 1, conflicts: 0 } },
    });
    expect(await h.repo.getAccount(sevenFixture.entries[0]!.playerId)).toBeUndefined();
  });

  it("previews and atomically applies the exact seven shells without login side effects", async () => {
    const body = batch("koi-2026-09-26-seven");
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(body));
    expect(preview).toMatchObject({
      status: 200,
      body: {
        dryRun: true,
        expectedHash: expect.any(String),
        applicable: true,
        counts: { create: 7, reuse: 0, unresolved: 0, conflicts: 0, aliasesToAdd: 1, evidenceToAdd: 11 },
        effects: {
          createsLogin: false,
          sendsInvite: false,
          sendsEmail: false,
          createsCredentials: false,
          linksHumanOwner: false,
          infersMainAltOwnership: false,
          changesMembership: false,
          writesScores: false,
        },
      },
    });
    expect((preview.body.rows as { decision: string }[]).every((row) => row.decision === "create_shell")).toBe(true);
    expect(await h.repo.getAccount("668923807")).toBeUndefined();

    const approved = { ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Reviewed exact seven-account reconciliation" };
    const applied = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(approved, { "idempotency-key": "koi-shells-20260926-v1" }));
    expect(applied).toMatchObject({ status: 201, body: { dryRun: false, replayed: false, counts: { create: 7 } } });
    expect(loginCalls).toEqual({ email: 0, password: 0, delete: 0 });
    for (const entry of sevenFixture.entries) {
      expect(await h.repo.getAccount(entry.playerId)).toMatchObject({ playerId: entry.playerId, name: entry.name, alliance: "POP", status: "unknown" });
      expect(await h.repo.linkedLoginAccess(entry.playerId)).toBeUndefined();
    }
    expect(await h.repo.listAliases("390464931")).toEqual([expect.objectContaining({ name: "Shadow Creature" })]);

    const replay = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(approved, { "idempotency-key": "koi-shells-20260926-v1" }));
    expect(replay).toMatchObject({ status: 200, body: { dryRun: false, replayed: true, counts: { create: 7 } } });
    const conflict = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...approved, reason: "Changed request" }, { "idempotency-key": "koi-shells-20260926-v1" }));
    expect(conflict.status).toBe(409);

    const readback = await h.call("GET", "/agent/accounts/390464931/reconciliation", agent());
    expect(readback).toMatchObject({
      status: 200,
      body: {
        account: { playerId: "390464931", name: "POPs Creature", status: "unknown" },
        hasLogin: false,
        aliases: [expect.objectContaining({ name: "Shadow Creature" })],
      },
    });
    expect(readback.body.sourceRecords).toHaveLength(2);
    expect(readback.body.sourceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ sourceCorrections: [expect.objectContaining({ observed: "POPs Creatire", status: "input_typo_not_alias" })] }) }),
    ]));
    const sting = await h.call("GET", "/agent/accounts/411751650/reconciliation", agent());
    expect(sting.body).toMatchObject({
      aliases: [],
      sourceRecords: expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ sourceScoreName: "The String", sourceCorrections: [expect.objectContaining({ correctedTo: "The Sting" })] }) }),
      ]),
    });

    const roster = await h.call("GET", "/roster", { as: "officer", groups: ["officer"] });
    expect(roster.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "390464931", hasLogin: false, status: "unknown" }),
    ]));

    await h.repo.linkAccount("future-verified-login", "390464931", { id: "officer", via: "web", reason: "verified later" });
    expect(await h.repo.linkedLogin("390464931")).toBe("future-verified-login");
    expect((await h.call("GET", "/agent/accounts/390464931/reconciliation", agent())).body).toMatchObject({
      hasLogin: true,
      aliases: [expect.objectContaining({ name: "Shadow Creature" })],
      sourceRecords: expect.arrayContaining([expect.objectContaining({ playerId: "390464931" })]),
    });
  });

  it("reuses an exact existing account unchanged and attaches only new evidence", async () => {
    await h.repo.createAccount({ playerId: "730000001", name: "Exact Frost", alliance: "POP", rank: "R3", status: "active", note: "Keep me" }, actor);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(batch("reuse-exact", [{
      sourceId: "reuse-source",
      playerId: "730000001",
      name: "Exact Frost",
      sourceScoreName: "Exact Frost",
      identityEvidence: "owner_supplied_id_and_name",
    }])));
    expect(preview.body).toMatchObject({ applicable: true, counts: { create: 0, reuse: 1, evidenceToAdd: 1 } });
    expect((preview.body.rows as Record<string, unknown>[])[0]).toMatchObject({
      decision: "reuse_exact",
      before: { rank: "R3", status: "active", note: "Keep me" },
      after: { rank: "R3", status: "active", note: "Keep me" },
    });
    const repeatedPreview = await h.call("POST", "/agent/accounts/reconcile", agent(batch("reuse-exact", [{
      sourceId: "reuse-source",
      playerId: "730000001",
      name: "Exact Frost",
      sourceScoreName: "Exact Frost",
      identityEvidence: "owner_supplied_id_and_name",
    }])));
    expect(repeatedPreview.body).toEqual(preview.body);
    const applied = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({
      ...batch("reuse-exact", [{
        sourceId: "reuse-source",
        playerId: "730000001",
        name: "Exact Frost",
        sourceScoreName: "Exact Frost",
        identityEvidence: "owner_supplied_id_and_name",
      }]),
      expectedHash: preview.body.expectedHash,
      approved: true,
      reason: "Reviewed exact-account reuse",
    }, { "idempotency-key": "reuse-exact-v1" }));
    expect(applied).toMatchObject({ status: 201, body: { counts: { create: 0, reuse: 1, evidenceToAdd: 1 } } });
    expect(await h.repo.getAccount("730000001")).toMatchObject({ rank: "R3", status: "active", note: "Keep me" });
  });

  it("preserves a UUID-only source as unresolved evidence without inventing an account", async () => {
    const body = batch("unresolved-source", [{
      sourceId: "legacy-uuid-only-17",
      playerId: null,
      name: "Unknown Frost",
      sourceScoreName: "Unknown Frost",
      identityEvidence: "legacy_uuid_only",
    }]);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(body));
    expect(preview.body).toMatchObject({ applicable: true, counts: { create: 0, unresolved: 1, evidenceToAdd: 1 } });
    expect((preview.body.rows as Record<string, unknown>[])[0]).toMatchObject({ decision: "preserve_unresolved", playerId: null, after: null });
    const approved = { ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Preserve unresolved source without matching by name" };
    expect((await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(approved, { "idempotency-key": "unresolved-source-v1" }))).status).toBe(201);
    const records = await h.repo.listHistoricalRecords("evidence");
    const unresolved = records.find((record) => record.sourceId === "legacy-uuid-only-17");
    expect(unresolved).toMatchObject({ sourceId: "legacy-uuid-only-17", reviewStatus: "unresolved" });
    expect(unresolved?.playerId).toBeUndefined();
    const roster = await h.call("GET", "/roster", { as: "officer", groups: ["officer"] });
    expect(roster.body.unresolvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "legacy-uuid-only-17", suppliedName: "Unknown Frost", reviewStatus: "unresolved" }),
    ]));
  });

  it("reports duplicate IDs, conflicting exact accounts and alias collisions before writes", async () => {
    await h.repo.createAccount({ playerId: "730000002", name: "Already Known", alliance: "POP", status: "active" }, actor);
    await h.repo.createAccount({ playerId: "730000003", name: "Claimed Alias", alliance: "POP", status: "active" }, actor);
    const conflicts = await h.call("POST", "/agent/accounts/reconcile", agent(batch("identity-conflicts", [
      { sourceId: "dup-a", playerId: "730000004", name: "Duplicate One", identityEvidence: "owner" },
      { sourceId: "dup-b", playerId: "730000004", name: "Duplicate Two", identityEvidence: "owner" },
      { sourceId: "existing-name", playerId: "730000002", name: "Different Name", identityEvidence: "owner" },
      { sourceId: "alias-collision", playerId: "730000005", name: "New Shell", identityEvidence: "owner", historicalSpreadsheetEvidence: { row: 1, name: "Claimed Alias", status: "historical_source_claim" } },
    ])));
    expect(conflicts.body).toMatchObject({ applicable: false, counts: { conflicts: 4 } });
    expect((conflicts.body.rows as { issues: string[] }[]).flatMap((row) => row.issues).join(" ")).toMatch(/more than once|canonical name|another Player ID/i);
    expect(await h.repo.getAccount("730000004")).toBeUndefined();
    expect(await h.repo.getAccount("730000005")).toBeUndefined();
  });

  it("rejects stale previews and incomplete apply authorization", async () => {
    const body = batch("stale-preview", [{ sourceId: "stale", playerId: "730000006", name: "Stale Frost", identityEvidence: "owner" }]);
    const preview = await h.call("POST", "/agent/accounts/reconcile", agent(body));
    expect((await h.call("POST", "/agent/accounts/reconcile?apply=true", agent(body, { "idempotency-key": "stale-preview-v1" }))).status).toBe(400);
    expect((await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...body, expectedHash: preview.body.expectedHash, reason: "Reviewed" }, { "idempotency-key": "stale-preview-v1" }))).status).toBe(400);
    expect((await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Reviewed" }))).status).toBe(400);
    await h.repo.createAccount({ playerId: "730000006", name: "Stale Frost", alliance: "POP", status: "unknown" }, actor);
    const stale = await h.call("POST", "/agent/accounts/reconcile?apply=true", agent({ ...body, expectedHash: preview.body.expectedHash, approved: true, reason: "Reviewed" }, { "idempotency-key": "stale-preview-v1" }));
    expect(stale.status).toBe(409);
    expect((await h.repo.listHistoricalRecords("evidence")).filter((record) => record.sourceId === "stale")).toEqual([]);
  });

  it("enforces scope, current officer authority and browser-origin rejection", async () => {
    const body = batch("auth-check", [{ sourceId: "auth", playerId: "730000007", name: "Auth Frost", identityEvidence: "owner" }]);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body, {}, readOnlyToken))).status).toBe(403);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body, { origin: "https://d37d5k4gjfzwry.cloudfront.net" }))).status).toBe(403);
    issuerGroups = new Set<Group>(["player"]);
    const officer = await h.repo.getAccount("700000001");
    await h.repo.updateAccount({ ...officer!, rank: "R3" }, actor);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body))).status).toBe(403);
    issuerGroups = new Set<Group>(["player", "officer"]);
    expect((await h.call("POST", "/agent/accounts/reconcile", agent(body))).status).toBe(403);
    await h.repo.updateAccount({ ...officer!, rank: "R4" }, actor);
  });

  it("previews only the seven held scores while preserving all 32 approved rows", async () => {
    const verified = scoreFixture.entries.filter((entry): entry is (typeof scoreFixture.entries)[number] & { playerId: string } => entry.identityStatus === "verified_registry" && entry.playerId !== null);
    for (const entry of verified) {
      if (!(await h.repo.getAccount(entry.playerId))) {
        await h.repo.createAccount({ playerId: entry.playerId, name: entry.displayName, alliance: "POP", status: "unknown" }, actor);
      }
    }
    await h.repo.createEvent({
      eventId: sevenFixture.eventId,
      alliance: "POP",
      kind: "koi",
      title: "King of Icefield",
      startsAt: "2026-09-26T10:00:00.000Z",
      deadlineAt: "2026-09-26T07:00:00.000Z",
      sessions: [],
      createdBy: "fixture",
    }, actor);
    await h.repo.putEventPhaseScores({
      eventId: sevenFixture.eventId,
      phaseKey: "castle_battle",
      phaseLabel: "Castle battle phase",
      version: 1,
      coverage: "partial",
      playerPoints: verified.map((entry) => ({ playerId: entry.playerId, points: entry.points, provenance: { sourceName: entry.sourceName, displayName: entry.displayName } })),
      source: { type: "owner_report", reference: "approved-32-row-receipt" },
      recordedAt: "2026-09-27T12:42:22.248Z",
      recordedBy: "fixture",
    }, actor);
    const held = sevenFixture.entries.map((entry) => ({
      playerId: entry.playerId,
      points: entry.pendingCastleBattlePoints,
      provenance: { sourceName: entry.sourceScoreName, displayName: entry.name },
    }));
    const preview = await h.call("PUT", `/agent/events/${sevenFixture.eventId}/phases/castle_battle/scores`, agent({
      expectedVersion: 1,
      coverage: "partial",
      playerPoints: held,
      source: { type: "owner_report", reference: "held-seven-after-separate-account-onboarding" },
    }));
    expect(preview).toMatchObject({
      status: 200,
      body: {
        dryRun: true,
        version: 2,
        coverage: "partial",
        counts: { added: 7, changed: 0, unchanged: 32 },
        subtotals: { before: 1_223_593_710, after: 1_415_767_691 },
      },
    });
    expect((preview.body.diff as { before: unknown[]; after: unknown[] }).before).toHaveLength(32);
    expect((preview.body.diff as { before: unknown[]; after: unknown[] }).after).toHaveLength(39);
    expect(await h.repo.getEventPhaseScores(sevenFixture.eventId, "castle_battle")).toMatchObject({ version: 1, playerPoints: expect.any(Array) });
    expect((await h.repo.getEventPhaseScores(sevenFixture.eventId, "castle_battle"))!.playerPoints).toHaveLength(32);
  });
});
