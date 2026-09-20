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
      body: { name: "Hermes", scopes: ["all:read", "results:write"], expiresInDays: 30 },
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
    expect(listed.body.items).toEqual([expect.objectContaining({ name: "Hermes", scopes: ["all:read", "results:write"] })]);
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
    expect(context.body).toMatchObject({ event: { eventId }, session: { id: "L1" }, result: null });
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

  it("enforces scopes and revocation", async () => {
    const issued = await h.call("POST", "/agent-tokens", {
      ...OFFICER,
      body: { name: "Reader", scopes: ["all:read"], expiresInDays: 7 },
    });
    const readToken = issued.body.token as string;
    const readHeaders = { authorization: `Bearer ${readToken}` };
    expect((await h.call("GET", "/agent/doctor", { headers: readHeaders })).status).toBe(200);
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
    const resultWrite = await h.call("PUT", `/agent/events/${eventId}/sessions/L1/result`, agent({
      outcome: "win", ourScore: 1, opponentScore: 0, playerPoints: [], expectedVersion: 1,
    }));
    expect(resultWrite.status).toBe(403);
    expect(resultWrite.body.title).toContain("no longer has permission");
    issuerGroups = new Set<Group>(["player", "officer"]);
  });
});
