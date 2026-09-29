import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { parseNewEvent } from "../../src/domain/events.js";
import { answerKey } from "../../src/data/keys.js";
import { createHarness, type Harness } from "./harness.js";

describe("guarded bot event registrations", () => {
  let h: Harness;
  let token: string;
  const eventId = "BOT-REGISTRATIONS";
  const actor = { id: "fixture", via: "seed" as const };

  beforeAll(async () => {
    h = await createHarness({ botIssuerGroups: async (issuedBy) => issuedBy === "officer" ? new Set(["player", "officer"] as const) : undefined });
    for (const [playerId, name, rank] of [
      ["710000001", "Officer", "R4"],
      ["710000002", "Traxes", "R4"],
      ["710000003", "xXsarahXx", "R3"],
      ["710000004", "AutoStone", "R3"],
      ["710000005", "Burbanks", "R3"],
      ["710000006", "Tarkan", "R3"],
      ["710000007", "Heroes", "R3"],
      ["710000008", "Commander C", "R3"],
      ["710000009", "Mouse", "R3"],
      ["710000010", "Cade", "R3"],
    ] as const) {
      await h.repo.createAccount(parseNewAccount({ playerId, name, rank }), actor);
    }
    await h.repo.linkAccount("officer", "710000001", actor);
    const event = parseNewEvent({
      kind: "foundry",
      title: "Foundry October 3",
      startsAt: "2030-10-03T12:00:00.000Z",
      deadlineAt: "2030-10-02T12:00:00.000Z",
      sessions: [
        { id: "L1", label: "Legion 1", startsAt: "2030-10-03T19:00:00.000Z" },
        { id: "L2", label: "Legion 2", startsAt: "2030-10-03T12:00:00.000Z" },
      ],
    }, { eventId, createdBy: "fixture", now: new Date("2030-09-01T00:00:00.000Z") });
    await h.repo.createEvent(event, actor);
    await h.repo.setAnswer(event, "710000002", { answer: "yes", sessionId: "L2" }, "player", actor);
    const canyon = parseNewEvent({
      kind: "canyon",
      title: "Canyon October 4",
      startsAt: "2030-10-04T12:00:00.000Z",
      deadlineAt: "2030-10-03T12:00:00.000Z",
      sessions: [
        { id: "L1", label: "Legion 1", startsAt: "2030-10-04T12:00:00.000Z" },
        { id: "L2", label: "Legion 2", startsAt: "2030-10-04T19:00:00.000Z" },
      ],
    }, { eventId: "BOT-REGISTRATIONS-CANYON", createdBy: "fixture", now: new Date("2030-09-01T00:00:00.000Z") });
    await h.repo.createEvent(canyon, actor);
    await h.repo.setAnswer(canyon, "710000002", { answer: "yes", sessionId: "L2" }, "player", actor);
    const issued = await h.call("POST", "/agent-tokens", {
      as: "officer",
      groups: ["officer"],
      body: { name: "Hermes registrations", scopes: ["all:read", "registrations:write"], expiresInDays: 30 },
    });
    token = issued.body.token as string;
  });

  afterAll(() => h.cleanup());

  const agent = (body?: unknown, headers: Record<string, string> = {}) => ({
    body,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

  it("rejects invalid players, sessions, and duplicate rows without writing", async () => {
    const unknown = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent({
      registrations: [{ playerId: "799999999", answer: "yes", sessionId: "L1" }],
    }));
    expect(unknown.status).toBe(400);
    const badSession = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent({
      registrations: [{ playerId: "710000003", answer: "yes", sessionId: "L9" }],
    }));
    expect(badSession.status).toBe(400);
    const duplicate = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent({
      registrations: [
        { playerId: "710000003", answer: "yes", sessionId: "L1" },
        { playerId: "710000003", answer: "yes", sessionId: "L2" },
      ],
    }));
    expect(duplicate.status).toBe(400);
    expect(await h.repo.getAnswer(eventId, "710000003")).toBeUndefined();
  });

  it("previews, atomically applies, reads back, and safely replays named registrations", async () => {
    const body = { registrations: [
      { playerId: "710000003", answer: "yes", sessionId: "L1", role: "substitute" },
      { playerId: "710000004", answer: "yes", sessionId: "L1" },
    ] };
    const preview = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent(body));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      expectedHash: expect.any(String),
      diff: [
        { before: null, after: { playerId: "710000003", role: "substitute" } },
        { before: null, after: { playerId: "710000004", role: null } },
      ],
    });
    expect(await h.repo.getAnswer(eventId, "710000003")).toBeUndefined();

    const applyBody = { ...body, approved: true, expectedHash: preview.body.expectedHash, reason: "Owner approved supplied registration list" };
    const applied = await h.call("PUT", `/agent/events/${eventId}/registrations?apply=true`, agent(applyBody, { "idempotency-key": "foundry-oct3-roster" }));
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ dryRun: false, replayed: false, result: { changed: 2, unchanged: 0 } });
    expect(await h.repo.getAnswer(eventId, "710000002")).toMatchObject({ answer: "yes", sessionId: "L2", source: "player" });
    expect(await h.repo.getAnswer(eventId, "710000003")).toMatchObject({ answer: "yes", sessionId: "L1", source: "officer", registrationRole: "substitute" });
    expect(await h.repo.getAnswer(eventId, "710000004")).toEqual(expect.not.objectContaining({ registrationRole: expect.anything() }));

    const raw = await h.db.send(new GetCommand({ TableName: h.tableName, Key: answerKey(eventId, "710000003") }));
    expect(raw.Item).toMatchObject({ via: expect.stringMatching(/^agent:/), reason: applyBody.reason, updatedBy: expect.any(String) });

    const readback = await h.call("GET", `/events/${eventId}`, agent());
    const l1 = (readback.body.sessions as { id: string; signedUpList: { playerId: string; registrationRole?: string }[] }[]).find((session) => session.id === "L1");
    expect(l1?.signedUpList).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "710000003", registrationRole: "substitute" }),
      expect.objectContaining({ playerId: "710000004" }),
    ]));
    const members = readback.body.members as { playerId: string; registrationRole?: string | null }[];
    expect(members.find((member) => member.playerId === "710000003")?.registrationRole).toBe("substitute");

    const replay = await h.call("PUT", `/agent/events/${eventId}/registrations?apply=true`, agent(applyBody, { "idempotency-key": "foundry-oct3-roster" }));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ dryRun: false, replayed: true, result: { changed: 2 } });
  });

  it("rejects an apply when a named registration changed after preview", async () => {
    const body = { registrations: [{ playerId: "710000005", answer: "yes", sessionId: "L1" }] };
    const preview = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent(body));
    const event = await h.repo.getEvent(eventId);
    await h.repo.setAnswer(event!, "710000005", { answer: "yes", sessionId: "L2" }, "officer", actor, undefined, { afterDeadline: true });
    const stale = await h.call("PUT", `/agent/events/${eventId}/registrations?apply=true`, agent({
      ...body,
      approved: true,
      expectedHash: preview.body.expectedHash,
      reason: "Stale owner-approved list",
    }, { "idempotency-key": "foundry-oct3-stale" }));
    expect(stale.status).toBe(409);
    expect(await h.repo.getAnswer(eventId, "710000005")).toMatchObject({ sessionId: "L2" });
  });

  it("accepts the approved Foundry/Canyon roster shape without touching Traxes", async () => {
    const foundry = { registrations: [
      { playerId: "710000003", answer: "yes", sessionId: "L1", role: "substitute" },
      { playerId: "710000004", answer: "yes", sessionId: "L1" },
      { playerId: "710000005", answer: "yes", sessionId: "L1" },
      { playerId: "710000006", answer: "yes", sessionId: "L1" },
      { playerId: "710000007", answer: "yes", sessionId: "L2" },
      { playerId: "710000008", answer: "yes", sessionId: "L2" },
      { playerId: "710000009", answer: "yes", sessionId: "L2" },
      { playerId: "710000010", answer: "yes", sessionId: "L2" },
    ] } as const;
    const canyon = { registrations: [
      { playerId: "710000007", answer: "yes", sessionId: "L1" },
      { playerId: "710000008", answer: "yes", sessionId: "L1" },
      { playerId: "710000009", answer: "yes", sessionId: "L1" },
      { playerId: "710000010", answer: "yes", sessionId: "L1" },
      { playerId: "710000003", answer: "yes", sessionId: "L2", role: "substitute" },
      { playerId: "710000004", answer: "yes", sessionId: "L2" },
      { playerId: "710000005", answer: "yes", sessionId: "L2" },
      { playerId: "710000006", answer: "yes", sessionId: "L2" },
    ] } as const;
    for (const [id, payload, key] of [
      [eventId, foundry, "approved-foundry-roster"],
      ["BOT-REGISTRATIONS-CANYON", canyon, "approved-canyon-roster"],
    ] as const) {
      const preview = await h.call("PUT", `/agent/events/${id}/registrations`, agent(payload));
      expect(preview.status).toBe(200);
      const applied = await h.call("PUT", `/agent/events/${id}/registrations?apply=true`, agent({
        ...payload,
        approved: true,
        expectedHash: preview.body.expectedHash,
        reason: "Owner approved all eight named registrations",
      }, { "idempotency-key": key }));
      expect(applied.status).toBe(200);
      expect((applied.body.result as { registrations: unknown[] }).registrations).toHaveLength(8);
      expect(await h.repo.getAnswer(id, "710000002")).toMatchObject({ answer: "yes", sessionId: "L2", source: "player" });
    }
    expect(await h.repo.getAnswer(eventId, "710000003")).toMatchObject({ sessionId: "L1", registrationRole: "substitute" });
    expect(await h.repo.getAnswer("BOT-REGISTRATIONS-CANYON", "710000003")).toMatchObject({ sessionId: "L2", registrationRole: "substitute" });
  });

  it("requires the dedicated permission and explicit approval", async () => {
    const missingScope = await h.call("POST", "/agent-tokens", {
      as: "officer", groups: ["officer"], body: { name: "Events only", scopes: ["all:read", "events:write"], expiresInDays: 30 },
    });
    const denied = await h.call("PUT", `/agent/events/${eventId}/registrations`, {
      body: { registrations: [{ playerId: "710000005", answer: "yes", sessionId: "L1" }] },
      headers: { authorization: `Bearer ${missingScope.body.token as string}` },
    });
    expect(denied.status).toBe(403);

    const preview = await h.call("PUT", `/agent/events/${eventId}/registrations`, agent({
      registrations: [{ playerId: "710000005", answer: "yes", sessionId: "L1" }],
    }));
    const unapproved = await h.call("PUT", `/agent/events/${eventId}/registrations?apply=true`, agent({
      registrations: [{ playerId: "710000005", answer: "yes", sessionId: "L1" }],
      expectedHash: preview.body.expectedHash,
      reason: "No explicit approval flag",
    }, { "idempotency-key": "foundry-not-approved" }));
    expect(unapproved.status).toBe(400);
  });
});
