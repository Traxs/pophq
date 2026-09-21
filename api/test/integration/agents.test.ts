import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    await h.repo.createAccount(parseNewAccount({ playerId: "700000001", name: "Northstar" }), actor);
    await h.repo.linkAccount("officer", "700000001", actor);
    const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const event = parseNewEvent(
      { kind: "foundry", title: "Hermes result", startsAt, sessions: [{ id: "L1", label: "Legion 1", startsAt }] },
      { eventId: "AGENT-RESULT", createdBy: "fixture", now: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    );
    await h.repo.createEvent(event, actor);
    eventId = event.eventId;
    const issued = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Hermes", scopes: ["all:read", "results:write", "events:write"], expiresInDays: 30 },
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
      expect.objectContaining({ name: "Hermes", scopes: ["all:read", "results:write", "events:write"] }),
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
      players: [{ playerId: "700000001", name: "Northstar" }],
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

  it("enforces scopes and revocation", async () => {
    const issued = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Reader", scopes: ["all:read"], expiresInDays: 7 },
    });
    const readToken = issued.body.token as string;
    const readHeaders = { authorization: `Bearer ${readToken}` };
    expect((await h.call("GET", "/agent/doctor", { headers: readHeaders })).status).toBe(200);
    expect((await h.call("POST", "/agent/events", { headers: readHeaders, body: {} })).status).toBe(403);
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
    expect((await h.call("GET", "/agent/doctor", agent())).status).toBe(200);
    expect((await h.call("GET", "/events", agent())).status).toBe(200);
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
    issuerGroups = new Set<Group>(["player", "officer"]);
  });
});
