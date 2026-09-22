import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { parseNewEvent } from "../../src/domain/events.js";
import type { Group } from "../../src/domain/principal.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };

describe("bot result agent", () => {
  let h: Harness;
  let eventId: string;
  let token: string;
  let issuerGroups = new Set<Group>(["player", "officer"]);

  beforeAll(async () => {
    h = await createHarness({ botIssuerGroups: async (issuedBy) => issuedBy === "officer" ? issuerGroups : undefined });
    const actor = { id: "fixture", via: "seed" as const };
    await h.repo.createAccount(parseNewAccount({ playerId: "700000001", name: "Northstar", rank: "R4" }), actor);
    await h.repo.linkAccount("officer", "700000001", actor);
    await h.repo.createAccount(parseNewAccount({ playerId: "700000002", name: "Lieutenant", rank: "R3" }), actor);
    await h.repo.linkAccount("r3-issuer", "700000002", actor);
    const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const event = parseNewEvent(
      { kind: "foundry", title: "Hermes result", startsAt, sessions: [{ id: "L1", label: "Legion 1", startsAt }] },
      { eventId: "AGENT-RESULT", createdBy: "fixture", now: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    );
    await h.repo.createEvent(event, actor);
    eventId = event.eventId;
    const issued = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Bot", scopes: ["all:read", "results:write", "events:write", "history:write", "rewards:write"], expiresInDays: 30 },
    });
    token = issued.body.token as string;
  });

  afterAll(() => h.cleanup());

  const agent = (body?: unknown, headers: Record<string, string> = {}) => ({
    body,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

  it("shows the secret once and lets the officer list and revoke metadata only", async () => {
    expect(token).toMatch(/^s26_[0-9a-z]{26}_[A-Za-z0-9_-]{43}$/);
    const listed = await h.call("GET", "/agent-tokens", OFFICER);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ name: "Bot", scopes: ["all:read", "results:write", "events:write", "history:write", "rewards:write"] }),
    ]);
  });

  it("reads a narrow result context and refuses browser use", async () => {
    const discovered = await h.call("GET", "/agent/events?kind=foundry", agent());
    expect(discovered.status).toBe(200);
    expect(discovered.body.items).toEqual([
      {
        eventId,
        kind: "foundry",
        title: "Hermes result",
        startsAt: expect.any(String),
        sessions: [{ id: "L1", label: "Legion 1", startsAt: expect.any(String) }],
      },
    ]);
    expect(JSON.stringify(discovered.body)).not.toContain("createdBy");
    expect(JSON.stringify(discovered.body)).not.toContain("notes");
    expect((await h.call("GET", "/agent/events?kind=admin", agent())).status).toBe(400);
    const context = await h.call("GET", `/agent/events/${eventId}/sessions/L1/result-context`, agent());
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      event: { eventId },
      session: { id: "L1" },
      lineup: [],
      players: expect.arrayContaining([{ playerId: "700000001", name: "Northstar" }]),
      result: null,
    });
    expect((await h.call("GET", "/agent/doctor", agent(undefined, { origin: "https://example.test" }))).status).toBe(403);
  });

  it("reads normal API data as the issuer but cannot use normal write routes", async () => {
    const events = await h.call("GET", "/events", agent());
    expect(events.status).toBe(200);
    expect(events.body.items).toEqual([expect.objectContaining({ eventId })]);
    expect((await h.call("GET", "/roster", agent())).status).toBe(200);
    const me = await h.call("GET", "/me", agent());
    expect(me.body).toMatchObject({ sub: "officer", accounts: [{ playerId: "700000001" }] });
    expect((await h.call("POST", "/events", agent({}))).status).toBe(403);
    expect((await h.call("GET", "/events", agent(undefined, { origin: "https://example.test" }))).status).toBe(403);
  });

  it("previews and idempotently applies historical event creation and editing", async () => {
    const startsAt = "2026-09-06T19:00:00.000Z";
    const createBody = {
      eventId: "HISTORY-2026-09-06-L2",
      kind: "foundry",
      title: "Foundry September 6",
      startsAt,
      deadlineAt: "2026-09-06T18:00:00.000Z",
      sessions: [{ id: "L2", label: "Legion 2", startsAt, starters: 30, subs: 10 }],
    };
    const preview = await h.call("POST", "/agent/events", agent(createBody));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, diff: { before: null, after: { eventId: createBody.eventId } } });
    expect(await h.repo.getEvent(createBody.eventId)).toBeUndefined();

    const appliedBody = { ...createBody, reason: "Approved historical event import" };
    const applied = await h.call(
      "POST",
      "/agent/events?apply=true",
      agent(appliedBody, { "idempotency-key": "event-create-001" }),
    );
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ dryRun: false, replayed: false, event: { eventId: createBody.eventId } });
    const replay = await h.call(
      "POST",
      "/agent/events?apply=true",
      agent(appliedBody, { "idempotency-key": "event-create-001" }),
    );
    expect(replay.body).toMatchObject({ replayed: true, event: { eventId: createBody.eventId } });

    const editBody = {
      title: "Foundry — September 6 L2",
      sessions: [{ id: "L2", label: "Legion 2 evening", startsAt, starters: 30, subs: 10 }],
    };
    const editPreview = await h.call("PATCH", `/agent/events/${createBody.eventId}`, agent(editBody));
    expect(editPreview.status).toBe(200);
    expect(editPreview.body).toMatchObject({
      dryRun: true,
      expectedHash: expect.any(String),
      diff: { after: { title: editBody.title, sessions: [{ id: "L2", label: "Legion 2 evening" }] } },
    });
    const editApply = await h.call(
      "PATCH",
      `/agent/events/${createBody.eventId}?apply=true`,
      agent(
        {
          ...editBody,
          expectedHash: editPreview.body.expectedHash,
          reason: "Approved historical event correction",
        },
        { "idempotency-key": "event-edit-001" },
      ),
    );
    expect(editApply.status).toBe(200);
    expect(editApply.body).toMatchObject({ event: { title: editBody.title } });

    const stale = await h.call(
      "PATCH",
      `/agent/events/${createBody.eventId}?apply=true`,
      agent(
        {
          title: "Stale overwrite",
          expectedHash: editPreview.body.expectedHash,
          reason: "This preview is stale",
        },
        { "idempotency-key": "event-edit-stale" },
      ),
    );
    expect(stale.status).toBe(409);
    const renamed = await h.call(
      "PATCH",
      `/agent/events/${createBody.eventId}`,
      agent({ sessions: [{ id: "RENAMED", label: "Renamed", startsAt }] }),
    );
    expect(renamed.status).toBe(400);
  });

  it("defaults to dry-run, requires reason and idempotency to apply, and safely replays", async () => {
    const body = {
      outcome: "win",
      ourScore: 100,
      opponentScore: 80,
      playerPoints: [{ playerId: "700000001", points: 12_345 }],
      expectedVersion: 0,
    };
    const preview = await h.call("PUT", `/agent/events/${eventId}/sessions/L1/result`, agent(body));
    expect(preview.body).toMatchObject({ dryRun: true, diff: { before: null, after: { version: 1, outcome: "win" } } });
    expect(await h.repo.getResult(eventId, "L1")).toBeUndefined();

    const noReason = await h.call("PUT", `/agent/events/${eventId}/sessions/L1/result?apply=true`, agent(body, { "idempotency-key": "result-001" }));
    expect(noReason.status).toBe(400);

    const appliedBody = { ...body, reason: "Imported reviewed Foundry scoreboard" };
    const first = await h.call(
      "PUT",
      `/agent/events/${eventId}/sessions/L1/result?apply=true`,
      agent(appliedBody, { "idempotency-key": "result-001" }),
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ dryRun: false, replayed: false, result: { version: 1 } });

    const replay = await h.call(
      "PUT",
      `/agent/events/${eventId}/sessions/L1/result?apply=true`,
      agent(appliedBody, { "idempotency-key": "result-001" }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, result: { version: 1 } });
  });

  it("previews and idempotently registers a complete reward haul", async () => {
    const body = {
      batchId: "fortress-2026-09-22-phase-3",
      source: "Fortress battle phase 3",
      acquiredAt: "2026-09-22T18:00:00.000Z",
      quantities: {
        allocatable: 40,
        speedup: 400,
        health: 60,
        hero_shard: 200,
        teleport: 90,
        damage: 60,
        deployment: 60,
        stronghold_material: 150,
        stronghold_component: 100,
        stronghold_hero_shard: 420,
        fire_crystal: 600,
      },
    };
    const preview = await h.call("POST", "/agent/rewards", agent(body));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      expectedHash: expect.any(String),
      unchanged: false,
      diff: { before: [], after: expect.arrayContaining([expect.objectContaining({ buff: "speedup", quantity: 400 })]) },
    });
    expect(await h.repo.getFortressBuffPool("reward-fortress-2026-09-22-phase-3-speedup")).toBeUndefined();

    const appliedBody = {
      ...body,
      expectedHash: preview.body.expectedHash,
      reason: "Officer approved screenshot extraction",
    };
    const applied = await h.call(
      "POST",
      "/agent/rewards?apply=true",
      agent(appliedBody, { "idempotency-key": "test-reward-write" }),
    );
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ dryRun: false, replayed: false, unchanged: false });
    expect(applied.body.rewards).toHaveLength(11);
    expect(applied.body.rewards).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: body.batchId })]));
    expect(await h.repo.getFortressBuffPool("reward-fortress-2026-09-22-phase-3-speedup"))
      .toMatchObject({ buff: "speedup", quantity: 400, remaining: 400, createdBy: expect.stringMatching(/^agent:/) });

    const replay = await h.call(
      "POST",
      "/agent/rewards?apply=true",
      agent(appliedBody, { "idempotency-key": "test-reward-write" }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ dryRun: false, replayed: true });
    expect(replay.body.rewards).toHaveLength(11);
  });

  it("only issues and honors reward-write tokens for a current POP R4/R5", async () => {
    const denied = await h.call("POST", "/agent-tokens", {
      as: "r3-issuer",
      groups: ["officer"],
      body: { name: "Rewards bot", scopes: ["all:read", "rewards:write"], expiresInDays: 7 },
    });
    expect(denied.status).toBe(403);

    const account = await h.repo.getAccount("700000001");
    expect(account).toBeDefined();
    await h.repo.updateAccount({ ...account!, rank: "R3" }, { id: "fixture", via: "seed" });
    const blocked = await h.call("POST", "/agent/rewards", agent({}));
    expect(blocked.status).toBe(403);
    expect(blocked.body.title).toContain("no longer an R4 or R5");
    await h.repo.updateAccount({ ...account!, rank: "R4" }, { id: "fixture", via: "seed" });
  });

  it("previews a team-only result when playerPoints is omitted", async () => {
    const preview = await h.call(
      "PUT",
      `/agent/events/${eventId}/sessions/L1/result`,
      agent({ outcome: "draw", ourScore: 50, opponentScore: 50, expectedVersion: 1 }),
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, diff: { after: { playerPoints: [] } } });
    expect(await h.repo.getResult(eventId, "L1")).toMatchObject({ version: 1, outcome: "win" });
  });

  it("previews, applies and reads the complete guarded historical surface", async () => {
    const apply = async (path: string, body: Record<string, unknown>, key: string) => {
      const preview = await h.call("PUT", path, agent(body));
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ dryRun: true, expectedHash: expect.any(String) });
      const applied = await h.call(
        "PUT",
        `${path}?apply=true`,
        agent(
          { ...body, expectedHash: preview.body.expectedHash, reason: "Approved historical backfill" },
          { "idempotency-key": key },
        ),
      );
      expect([200, 201]).toContain(applied.status);
      return applied;
    };

    const report = await apply(
      "/agent/history/reports/700000001/IMPORT-strength-1",
      {
        effectiveAt: "2026-09-06T00:00:00.000Z",
        recordedAt: "2026-09-07T08:00:00.000Z",
        values: [{ metric: "foundry_strength", value: 9876, precision: "date" }],
        note: "reviewed fixture observation",
      },
      "history-report-001",
    );
    expect(report.body.report).toMatchObject({ reportId: "IMPORT-strength-1", source: "import", values: [{ precision: "date" }] });

    const signup = await apply(
      `/agent/history/events/${eventId}/signups/700000001`,
      { answer: "yes", sessionId: "L1", answeredAt: "2026-09-01T12:00:00.000Z" },
      "history-signup-001",
    );
    expect(signup.body.signup).toMatchObject({ answer: "yes", source: "import", sessionId: "L1" });

    const attendance = await apply(
      `/agent/history/events/${eventId}/attendance/700000001`,
      { status: "present", sessionId: "L1", source: "screenshot", recordedAt: "2026-09-06T14:00:00.000Z", evidenceRef: "shot-1" },
      "history-attend-001",
    );
    expect(attendance.body.attendance).toMatchObject({ status: "present", source: "screenshot", evidenceRef: "shot-1" });

    const lineup = await apply(
      `/agent/history/events/${eventId}/sessions/L1/lineup`,
      { entries: [{ playerId: "700000001", role: "starter" }], publishedAt: "2026-09-05T18:00:00.000Z", expectedVersion: 0 },
      "history-lineup-001",
    );
    expect(lineup.body.lineup).toMatchObject({ entries: [{ playerId: "700000001", role: "starter", position: 1 }] });

    const strategy = await apply(
      `/agent/history/events/${eventId}/sessions/L1/strategy`,
      {
        body: "Hold the gate",
        assignments: [{ playerId: "700000001", role: "Holder", duty: "Gate one" }],
        publishedAt: "2026-09-05T19:00:00.000Z",
        expectedVersion: 0,
      },
      "history-strategy-001",
    );
    expect(strategy.body.strategy).toMatchObject({ body: "Hold the gate", assignments: [{ role: "Holder" }] });

    const alias = await apply(
      "/agent/history/alias-uuid-1",
      { category: "alias", sourceId: "source-alias-1", playerId: "700000001", occurredAt: "2026-09-01T00:00:00Z", payload: { name: "Old Northstar", verified: true } },
      "history-alias-001",
    );
    expect(alias.body.record).toMatchObject({ category: "alias", sourceId: "source-alias-1" });
    const listed = await h.call("GET", "/agent/history?category=alias", agent());
    expect(listed.body.items).toEqual([expect.objectContaining({ recordId: "alias-uuid-1" })]);

    const bytes = Buffer.from("reviewed evidence bytes");
    const evidence = await apply(
      "/agent/history/evidence/evidence-shot-1/content",
      {
        contentBase64: bytes.toString("base64"),
        contentType: "text/plain",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      "history-evidence-001",
    );
    expect(evidence.body.evidence).toMatchObject({ recordId: "evidence-shot-1", size: bytes.length, contentType: "text/plain" });
    expect(Buffer.from(h.evidenceObjects.get("evidence-shot-1")!.content).equals(bytes)).toBe(true);
  });

  it("enforces scopes and revocation", async () => {
    const issued = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Reader", scopes: ["all:read"], expiresInDays: 7 },
    });
    const readToken = issued.body.token as string;
    const readHeaders = { authorization: `Bearer ${readToken}` };
    expect((await h.call("GET", "/agent/doctor", { headers: readHeaders })).status).toBe(200);
    expect((await h.call("POST", "/agent/events", { headers: readHeaders, body: {} })).status).toBe(403);
    expect((await h.call("POST", "/agent/rewards", { headers: readHeaders, body: {} })).status).toBe(403);
    expect((await h.call("PUT", "/agent/history/alias-nope", { headers: readHeaders, body: {} })).status).toBe(403);
    expect(
      (
        await h.call("PUT", `/agent/events/${eventId}/sessions/L1/result`, {
          headers: readHeaders,
          body: { outcome: "win", ourScore: 1, opponentScore: 0, playerPoints: [], expectedVersion: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await h.call("DELETE", `/agent-tokens/${issued.body.tokenId as string}`, OFFICER)).status).toBe(200);
    expect((await h.call("GET", "/agent/doctor", { headers: readHeaders })).status).toBe(401);

    const legacy = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Legacy reader", scopes: ["results:read"], expiresInDays: 7 },
    });
    const legacyHeaders = { authorization: `Bearer ${legacy.body.token as string}` };
    expect((await h.call("GET", "/events", { headers: legacyHeaders })).status).toBe(200);
    expect((await h.call("GET", "/agent/doctor", { headers: legacyHeaders })).body.scopes).toEqual(["all:read"]);
  });

  it("tracks the issuer's current read and write rights", async () => {
    expect((await h.call("GET", "/agent/doctor", agent())).status).toBe(200);
    issuerGroups = new Set<Group>(["player"]);
    const officerAccount = await h.repo.getAccount("700000001");
    await h.repo.updateAccount({ ...officerAccount!, rank: "R3" }, { id: "fixture", via: "seed" });
    expect((await h.call("GET", "/agent/doctor", agent())).status).toBe(200);
    expect((await h.call("GET", "/events", agent())).status).toBe(200);
    expect((await h.call("GET", "/agent/history?category=alias", agent())).status).toBe(403);
    const playerContext = await h.call("GET", `/agent/events/${eventId}/sessions/L1/result-context`, agent());
    expect(playerContext.status).toBe(200);
    expect(playerContext.body.players).toBeUndefined();
    const resultWrite = await h.call("PUT", `/agent/events/${eventId}/sessions/L1/result`, agent({
      outcome: "win", ourScore: 1, opponentScore: 0, playerPoints: [], expectedVersion: 1,
    }));
    expect(resultWrite.status).toBe(403);
    expect(resultWrite.body.title).toContain("no longer has permission");
    const eventWrite = await h.call("PATCH", "/agent/events/HISTORY-2026-09-06-L2", agent({ title: "No longer allowed" }));
    expect(eventWrite.status).toBe(403);
    const historyWrite = await h.call("PUT", "/agent/history/alias-demoted", agent({ category: "alias" }));
    expect(historyWrite.status).toBe(403);
    await h.repo.updateAccount({ ...officerAccount!, rank: "R4" }, { id: "fixture", via: "seed" });
    issuerGroups = new Set<Group>(["player", "officer"]);
  });
});
