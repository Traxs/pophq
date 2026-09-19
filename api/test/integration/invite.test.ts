import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "../../src/domain/errors.js";
import { invite, parseEmail, type LoginDirectory } from "../../src/ops/invite.js";
import { createHarness, type Harness } from "./harness.js";

const actor = { id: "officer-1", via: "web" as const };

/** Stand-in for Cognito: remembers logins by email. */
function fakeLogins(): LoginDirectory & { subs: Map<string, string>; created: string[] } {
  const subs = new Map<string, string>();
  const created: string[] = [];
  return {
    subs,
    created,
    findSub: async (email) => subs.get(email),
    createLogin: async (email) => {
      const sub = `sub-${email}`; // unique per email: tests share one table
      subs.set(email, sub);
      created.push(sub);
      return sub;
    },
    deleteLogin: async (sub) => {
      for (const [email, s] of subs) if (s === sub) subs.delete(email);
    },
  };
}

describe("invite", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.cleanup());

  it("creates the login, the game account and the link in one go", async () => {
    const logins = fakeLogins();
    const res = await invite(
      { repo: h.repo, logins, actor },
      { email: " New.Member@Example.com ", playerId: "200000001", name: "Frostbite", rank: "R3" },
    );
    expect(res).toMatchObject({ accountCreated: true, loginCreated: true, linked: true, seats: { used: 1, cap: 100 } });
    expect(logins.subs.get("new.member@example.com")).toBe(res.sub);

    const me = await h.call("GET", "/me", { as: res.sub! });
    expect(me.body.accounts).toEqual([expect.objectContaining({ playerId: "200000001", name: "Frostbite", rank: "R3" })]);
  });

  it("repeating an invite changes nothing", async () => {
    const logins = fakeLogins();
    const first = await invite({ repo: h.repo, logins, actor }, { email: "twice@example.com", playerId: "200000002", name: "Repeat" });
    const again = await invite({ repo: h.repo, logins, actor }, { email: "twice@example.com", playerId: "200000002", name: "Renamed" });
    expect(again).toMatchObject({ sub: first.sub, accountCreated: false, loginCreated: false, linked: false });
    expect(again.account.name).toBe("Repeat");
    expect(again.seats.used).toBe(first.seats.used);
  });

  it("adds a game account without a login when no email is given", async () => {
    const logins = fakeLogins();
    const before = await h.repo.seats();
    const res = await invite({ repo: h.repo, logins, actor }, { email: "  ", playerId: "200000003", name: "NoLogin" });
    expect(res).toMatchObject({ accountCreated: true, loginCreated: false, linked: false });
    expect(res.sub).toBeUndefined();
    expect(res.seats.used).toBe(before.used);
  });

  it("gives a login a second game account (alt) without using another seat", async () => {
    const logins = fakeLogins();
    const first = await invite({ repo: h.repo, logins, actor }, { email: "alts@example.com", playerId: "200000004", name: "Main" });
    const alt = await invite({ repo: h.repo, logins, actor }, { email: "alts@example.com", playerId: "200000005", name: "Alt" });
    expect(alt).toMatchObject({ sub: first.sub, loginCreated: false, linked: true });
    expect(alt.seats.used).toBe(first.seats.used);
    expect((await h.repo.linkedAccounts(first.sub!)).toSorted()).toEqual(["200000004", "200000005"]);
  });

  it("refuses to take a game account that already belongs to someone else", async () => {
    const logins = fakeLogins();
    await invite({ repo: h.repo, logins, actor }, { email: "owner@example.com", playerId: "200000006", name: "Owner" });
    await expect(
      invite({ repo: h.repo, logins, actor }, { email: "thief@example.com", playerId: "200000006", name: "Owner" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("stops at the seat cap and removes the login it just created", async () => {
    const small = await createHarness();
    const logins = fakeLogins();
    const opts = { repo: small.repo, logins, actor, seatCap: 2 };
    await invite(opts, { email: "one@example.com", playerId: "200000011", name: "One" });
    await invite(opts, { email: "two@example.com", playerId: "200000012", name: "Two" });
    await expect(invite(opts, { email: "three@example.com", playerId: "200000013", name: "Three" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(logins.subs.has("three@example.com")).toBe(false);
    expect((await small.repo.seats(2)).used).toBe(2);
    await small.cleanup();
  });

  it("keeps the cap under concurrent invites and frees the losers' logins", async () => {
    const small = await createHarness();
    const logins = fakeLogins();
    // Every invite sees free seats before reserving, so the transaction decides the winners.
    vi.spyOn(small.repo, "seats").mockResolvedValueOnce({ used: 0, cap: 3 });
    const opts = { repo: small.repo, logins, actor, seatCap: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        invite(opts, { email: `race${i}@example.com`, playerId: `3000000${10 + i}`, name: `Racer${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await small.repo.seats(3)).used).toBe(3);
    expect(logins.subs.size).toBe(3);
    await small.cleanup();
  });
});

describe("POST /v1/invites", () => {
  let h: Harness;
  const logins = fakeLogins();
  beforeAll(async () => {
    h = await createHarness({ logins });
  });
  afterAll(() => h.cleanup());

  it("lets an officer invite someone and reports what happened", async () => {
    const res = await h.call("POST", "/invites", {
      as: "officer-1",
      groups: ["officer"],
      body: { email: "route@example.com", playerId: "400000001", name: "Routed", rank: "R2" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      accountCreated: true,
      loginCreated: true,
      linked: true,
      seats: { used: 1, cap: 100 },
      account: { playerId: "400000001", name: "Routed", rank: "R2", alliance: "POP", status: "active" },
    });

    const again = await h.call("POST", "/invites", {
      as: "officer-1",
      groups: ["officer"],
      body: { email: "route@example.com", playerId: "400000001", name: "Routed" },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accountCreated: false, loginCreated: false, linked: false });
  });

  it("is officer-only and validates its input", async () => {
    const asPlayer = await h.call("POST", "/invites", { as: "player-1", body: { playerId: "400000002", name: "Nope" } });
    expect(asPlayer.status).toBe(403);

    for (const body of [
      { email: "not-an-email", playerId: "400000003", name: "Bad" },
      { email: "ok@example.com", playerId: "12", name: "Bad" },
      { email: "ok@example.com", playerId: "400000004", name: "" },
    ]) {
      const res = await h.call("POST", "/invites", { as: "officer-1", groups: ["officer"], body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("reports the roster's seat usage to officers", async () => {
    const res = await h.call("GET", "/roster", { as: "officer-1", groups: ["officer"] });
    expect(res.body.seats).toMatchObject({ cap: 100 });
  });
});

describe("parseEmail", () => {
  it.each(["a@b.co", " Mixed.Case@Example.COM "])("accepts %j", (v) => {
    expect(parseEmail(v)).toBe(v.trim().toLowerCase());
  });
  it.each(["", "no-at", "a@b", "a b@c.de", `${"x".repeat(250)}@example.com`])("rejects %j", (v) => {
    expect(() => parseEmail(v)).toThrow(ValidationError);
  });
});
