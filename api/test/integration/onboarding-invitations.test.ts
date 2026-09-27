import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoginDirectory } from "../../src/ops/invite.js";
import { createHarness, type Harness } from "./harness.js";

const actor = { id: "seed", via: "seed" as const, reason: "test" };
let clock = new Date("2026-09-28T10:00:00.000Z");
const created: { email: string[]; password: (string | undefined)[]; deleted: string[] } = { email: [], password: [], deleted: [] };
let passwordSequence = 0;
const logins: LoginDirectory = {
  findSub: async () => undefined,
  createLogin: async (email) => { created.email.push(email); return `email-sub-${email}`; },
  createPasswordLogin: async (name) => {
    created.password.push(name);
    passwordSequence += 1;
    return { sub: `password-sub-${passwordSequence}`, username: `${name}@members.pophq.invalid`, password: "Temporary-Secure-123" };
  },
  resetPassword: async () => ({ password: "unused" }),
  disableLogin: async () => undefined,
  enableLogin: async () => undefined,
  deleteLogin: async (sub) => { created.deleted.push(sub); },
};

describe("one-time player onboarding invitations", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ logins, now: () => clock });
    for (const [playerId, name] of [["710000001", "Frost Wolf"], ["710000002", "Ice Fox"], ["710000003", "Snow Owl"], ["710000004", "Fail Bear"]] as const) {
      await h.repo.createAccount({ playerId, name, alliance: "POP", rank: "R3", status: "active" }, actor);
    }
  });
  afterAll(() => h.cleanup());

  const issue = (playerId: string) => h.call("POST", "/onboarding-invitations", {
    as: "officer-1", groups: ["officer"], body: { playerId, name: "ignored" },
  });

  it("requires an officer, binds exactly one player, lasts 24 hours, and never stores the raw token", async () => {
    const forbidden = await h.call("POST", "/onboarding-invitations", { as: "player-1", body: { playerId: "710000001", name: "Frost Wolf" } });
    expect(forbidden.status).toBe(403);

    const issued = await issue("710000001");
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ playerId: "710000001", playerName: "Frost Wolf", expiresAt: "2026-09-29T10:00:00.000Z" });
    const token = String(issued.body.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const scan = await h.db.send(new ScanCommand({ TableName: h.tableName }));
    expect(JSON.stringify(scan.Items)).not.toContain(token);
    const tokenRecord = scan.Items?.find((item) => item.type === "onboarding-invite-token" && item.playerId === "710000001");
    const auditRecord = scan.Items?.find((item) => item.type === "onboarding-invite-audit" && item.playerId === "710000001");
    expect(tokenRecord?.expiresAtEpoch).toBe(Math.floor(Date.parse("2026-09-29T10:00:00.000Z") / 1000));
    expect(auditRecord).not.toHaveProperty("expiresAtEpoch");

    const inspected = await h.call("POST", "/onboarding-invitations/inspect", { body: { token } });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toEqual({ playerId: "710000001", playerName: "Frost Wolf", expiresAt: "2026-09-29T10:00:00.000Z" });
  });

  it("lets the player choose email OTP and rejects every replay", async () => {
    const token = String((await issue("710000002")).body.token);
    const redeemed = await h.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "email", email: " PLAYER@example.com " } });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body).toMatchObject({ method: "email", signInIdentifier: "player@example.com", account: { playerId: "710000002" } });
    expect(created.email).toContain("player@example.com");
    expect(await h.repo.linkedLogin("710000002")).toBe("email-sub-player@example.com");
    expect((await h.call("POST", "/onboarding-invitations/inspect", { body: { token } })).status).toBe(404);
    expect((await h.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "email", email: "other@example.com" } })).status).toBe(404);
  });

  it("atomically permits only one concurrent redemption", async () => {
    const token = String((await issue("710000003")).body.token);
    const [a, b] = await Promise.all([
      h.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "password", loginName: "snow-owl" } }),
      h.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "password", loginName: "snow-owl" } }),
    ]);
    expect([a.status, b.status].toSorted()).toEqual([201, 409]);
    expect(created.password.filter((name) => name === "snow-owl")).toHaveLength(1);
    const success = a.status === 201 ? a : b;
    expect(success.body).toMatchObject({
      method: "password",
      signInIdentifier: "snow-owl@members.pophq.invalid",
      credentials: { username: "snow-owl@members.pophq.invalid", password: "Temporary-Secure-123" },
    });
  });

  it("rejects expired links without creating a login", async () => {
    const issued = await issue("710000004");
    const token = String(issued.body.token);
    clock = new Date("2026-09-29T10:00:00.001Z");
    const before = created.email.length;
    const result = await h.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "email", email: "late@example.com" } });
    expect(result.status).toBe(404);
    expect(created.email).toHaveLength(before);
  });

  it("consumes and audits a link when Cognito creation fails", async () => {
    clock = new Date("2026-09-30T10:00:00.000Z");
    await h.repo.createAccount({ playerId: "710000005", name: "Error Yak", alliance: "POP", rank: "R3", status: "active" }, actor);
    const failing: LoginDirectory = { ...logins, createLogin: vi.fn(async () => { throw new Error("provider unavailable"); }) };
    const isolated = await createHarness({ logins: failing, now: () => clock });
    try {
      await isolated.repo.createAccount({ playerId: "710000006", name: "Error Lynx", alliance: "POP", rank: "R3", status: "active" }, actor);
      const issued = await isolated.call("POST", "/onboarding-invitations", { as: "officer-1", groups: ["officer"], body: { playerId: "710000006", name: "Error Lynx" } });
      const token = String(issued.body.token);
      const failed = await isolated.call("POST", "/onboarding-invitations/redeem", { body: { token, method: "email", email: "fail@example.com" } });
      expect(failed.status).toBe(409);
      expect((await isolated.call("POST", "/onboarding-invitations/inspect", { body: { token } })).status).toBe(404);
      expect(await isolated.repo.linkedLogin("710000006")).toBeUndefined();
      expect(await isolated.repo.listOnboardingInviteAudit("710000006")).toEqual([
        expect.objectContaining({ status: "failed", method: "email", failureCode: "provider_error" }),
      ]);
    } finally {
      await isolated.cleanup();
    }
  });
});
