import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const R4 = { as: "officer", groups: ["officer"] };
const MEMBER = { as: "player", headers: { "x-account-id": "100000001" } };

describe("account identity workflow", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date("2026-09-22T12:00:00Z"));
  });
  afterAll(() => h.cleanup());

  it("is restricted to R4/R5 and initially groups accounts sharing a login", async () => {
    expect((await h.call("GET", "/accounts/100000001/identity", MEMBER)).status).toBe(403);
    const result = await h.call("GET", "/accounts/100000001/identity", R4);
    expect(result.status).toBe(200);
    expect(result.body.primaryPlayerId).toBe("100000001");
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", name: "Poppy", isPrimary: true }),
      expect.objectContaining({ playerId: "100000002", name: "Goatzilla", isPrimary: false }),
    ]));
  });

  it("adds searchable aliases and records why", async () => {
    const result = await h.call("POST", "/accounts/100000001/aliases", {
      ...R4,
      body: { name: "Old Poppy", justification: "Verified from alliance records" },
    });
    expect(result.status).toBe(201);
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", aliases: [expect.objectContaining({ name: "Old Poppy" })] }),
    ]));
    expect(result.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "alias_add", alias: "Old Poppy", justification: "Verified from alliance records" }),
    ]));
    const roster = await h.call("GET", "/roster", R4);
    expect((roster.body.items as { playerId: string; aliases: string[] }[]).find((row) => row.playerId === "100000001")?.aliases).toContain("Old Poppy");
  });

  it("links and manages two accounts before either person has a sign-in", async () => {
    await h.repo.createAccount({ playerId: "299000001", name: "Mando Test", alliance: "POP", status: "active" }, { id: "test", via: "web" });
    await h.repo.createAccount({ playerId: "299000002", name: "Grogu Test", alliance: "POP", status: "active" }, { id: "test", via: "web" });

    const linked = await h.call("POST", "/accounts/299000001/identity/accounts", {
      ...R4,
      body: { secondaryPlayerId: "299000002", justification: "Confirmed as the same player" },
    });
    expect(linked.status).toBe(201);
    expect(linked.body.primaryPlayerId).toBe("299000001");
    expect(linked.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "299000001", isPrimary: true }),
      expect.objectContaining({ playerId: "299000002", isPrimary: false }),
    ]));
    expect(await h.repo.linkedLogin("299000001")).toBeUndefined();
    expect(await h.repo.linkedLogin("299000002")).toBeUndefined();

    const changed = await h.call("PUT", "/accounts/299000001/identity/main", {
      ...R4,
      body: { playerId: "299000002", justification: "Grogu is now the main account" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.primaryPlayerId).toBe("299000002");
  });

  it("protects the implicit main account until another main is selected", async () => {
    const result = await h.call("DELETE", "/accounts/100000002/identity/accounts/100000001", {
      ...R4,
      body: { justification: "Trying to remove the current main" },
    });
    expect(result.status).toBe(409);
  });

  it("links an unclaimed secondary account and allows choosing it as main", async () => {
    const linked = await h.call("POST", "/accounts/100000001/identity/accounts", {
      ...R4,
      body: { secondaryPlayerId: "100000003", justification: "Confirmed as the same person" },
    });
    expect(linked.status).toBe(201);
    expect(linked.body.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ playerId: "100000003" })]));
    expect(linked.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "link_secondary", relatedPlayerId: "100000003", justification: "Confirmed as the same person" }),
    ]));
    const me = await h.call("GET", "/me", MEMBER);
    expect(me.status).toBe(200);
    expect((me.body.accounts as { playerId: string }[]).map((account) => account.playerId)).toEqual(
      expect.arrayContaining(["100000001", "100000002", "100000003"]),
    );

    const changed = await h.call("PUT", "/accounts/100000001/identity/main", {
      ...R4,
      body: { playerId: "100000003", justification: "This is their active main account" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.primaryPlayerId).toBe("100000003");
    expect(await h.repo.linkedAccountGroups(["100000001", "100000002", "100000003"])).toEqual([
      ["100000003", "100000001", "100000002"],
    ]);
  });

  it("unlinks only the relationship and retains the account and audit history", async () => {
    const result = await h.call("DELETE", "/accounts/100000001/identity/accounts/100000002", {
      ...R4,
      body: { justification: "Ownership was entered incorrectly" },
    });
    expect(result.status).toBe(200);
    expect((result.body.accounts as { playerId: string }[]).map((account) => account.playerId)).not.toContain("100000002");
    expect(await h.repo.getAccount("100000002")).toMatchObject({ name: "Goatzilla" });
    expect(result.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "unlink_secondary", relatedPlayerId: "100000002" }),
    ]));
  });

  it("rejects short reasons and accounts already claimed by another login", async () => {
    expect((await h.call("POST", "/accounts/100000001/aliases", { ...R4, body: { name: "Other", justification: "no" } })).status).toBe(400);
    expect((await h.call("POST", "/accounts/100000001/identity/accounts", {
      ...R4,
      body: { secondaryPlayerId: "100000008", justification: "Definitely the same person" },
    })).status).toBe(409);
  });
});
