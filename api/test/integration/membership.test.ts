import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import type { LoginDirectory } from "../../src/ops/invite.js";
import { createHarness, type Harness } from "./harness.js";

describe("reversible person membership", () => {
  let h: Harness;
  const disabled: string[] = [];
  const enabled: string[] = [];
  const logins: LoginDirectory = {
    findSub: async () => undefined,
    createLogin: async () => "unused",
    createPasswordLogin: async () => ({ sub: "unused", username: "unused", password: "unused" }),
    resetPassword: async () => ({ password: "unused" }),
    disableLogin: async (sub) => { disabled.push(sub); },
    enableLogin: async (sub) => { enabled.push(sub); },
    deleteLogin: async () => undefined,
  };

  beforeAll(async () => {
    h = await createHarness({ logins });
    await seedDemo(h.repo, new Date("2026-09-27T12:00:00Z"));
  });
  afterAll(() => h.cleanup());

  it("marks the main and every secondary account as left and suspends their shared login", async () => {
    const result = await h.call("PUT", "/accounts/100000001/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: false, justification: "Confirmed departure from POP" },
    });

    expect(result.status).toBe(200);
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", status: "transferred_out" }),
      expect.objectContaining({ playerId: "100000002", status: "transferred_out" }),
    ]));
    expect(disabled).toEqual(["player"]);
    expect((result.body.audit as unknown[])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "membership_left",
        justification: "Confirmed departure from POP",
        affectedPlayerIds: ["100000001", "100000002"],
      }),
    ]));
    expect((await h.call("GET", "/me", { as: "player" })).status).toBe(403);
  });

  it("welcomes the person and all linked accounts back without losing history", async () => {
    const result = await h.call("PUT", "/accounts/100000002/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: true, justification: "Return confirmed by alliance leadership" },
    });

    expect(result.status).toBe(200);
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", status: "active" }),
      expect.objectContaining({ playerId: "100000002", status: "active" }),
    ]));
    expect(enabled).toEqual(["player"]);
    expect((await h.call("GET", "/me", { as: "player" })).status).toBe(200);
    expect((await h.repo.listReports("100000001")).length).toBeGreaterThan(0);
  });

  it("requires R4/R5 access and a permanent reason", async () => {
    expect((await h.call("PUT", "/accounts/100000001/membership", {
      as: "player",
      body: { active: false, justification: "Leaving again" },
    })).status).toBe(403);
    expect((await h.call("PUT", "/accounts/100000001/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: false, justification: "no" },
    })).status).toBe(400);
  });
});
