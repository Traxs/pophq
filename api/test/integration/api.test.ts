import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
const OFFICER = { as: "officer-1", groups: ["officer"] };
const PLAYER = { as: "player-1" };

beforeAll(async () => {
  h = await createHarness();
  for (const body of [
    { playerId: "100000001", name: "Poppy" },
    { playerId: "100000002", name: "Goatzilla" },
    { playerId: "100000003", name: "IceQueen" },
    { playerId: "200000001", name: "MirGuest", alliance: "MIR", status: "guest" },
  ]) {
    expect((await h.call("POST", "/accounts", { ...OFFICER, body })).status).toBe(201);
  }
  for (const pid of ["100000001", "100000002"]) {
    expect((await h.call("POST", `/accounts/${pid}/links`, { ...OFFICER, body: { sub: "player-1" } })).status).toBe(
      201,
    );
  }
});

afterAll(() => h.cleanup());

describe("authentication", () => {
  it("serves health without a token", async () => {
    expect(await h.call("GET", "/health")).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("refuses requests without or with a bad token", async () => {
    expect((await h.call("GET", "/me")).status).toBe(401);
    expect((await h.call("GET", "/me", { headers: { authorization: "Bearer not-a-jwt" } })).status).toBe(401);
  });
});

describe("accounts", () => {
  it("returns the caller's linked game accounts (main + alt)", async () => {
    const res = await h.call("GET", "/me", PLAYER);
    expect(res.status).toBe(200);
    expect((res.body.accounts as { playerId: string }[]).map((a) => a.playerId).sort()).toEqual([
      "100000001",
      "100000002",
    ]);
  });

  it("lets only officers create accounts", async () => {
    const res = await h.call("POST", "/accounts", { ...PLAYER, body: { playerId: "100000099", name: "Sneaky" } });
    expect(res.status).toBe(403);
  });

  it("refuses a duplicate Player ID", async () => {
    const res = await h.call("POST", "/accounts", { ...OFFICER, body: { playerId: "100000001", name: "Copy" } });
    expect(res.status).toBe(409);
  });

  it("refuses linking an account that is already linked to another login", async () => {
    const res = await h.call("POST", "/accounts/100000001/links", { ...OFFICER, body: { sub: "someone-else" } });
    expect(res.status).toBe(409);
  });

  it("refuses acting as an account that isn't linked (FM-04)", async () => {
    const res = await h.call("GET", "/me", { ...PLAYER, headers: { "x-account-id": "100000003" } });
    expect(res.status).toBe(403);
  });
});

describe("power reports", () => {
  const values = [
    { metric: "city_power", value: 51_000_000 },
    { metric: "troop_level_infantry", value: "FC9" },
    { metric: "helios_infantry", value: "yes" },
  ];

  it("accepts a report for the player's own alt and computes current values", async () => {
    const res = await h.call("POST", "/accounts/100000002/reports", { ...PLAYER, body: { values } });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("player");

    const list = await h.call("GET", "/accounts/100000002/reports", PLAYER);
    expect(list.status).toBe(200);
    expect(list.body.current).toMatchObject({
      city_power: { value: 51_000_000 },
      troop_level_infantry: { value: "FC9" },
      helios_infantry: { value: "yes" },
    });
  });

  it("refuses a report for someone else's account", async () => {
    const res = await h.call("POST", "/accounts/100000003/reports", { ...PLAYER, body: { values } });
    expect(res.status).toBe(403);
  });

  it("records officer entries for other accounts as officer-sourced", async () => {
    const res = await h.call("POST", "/accounts/200000001/reports", { ...OFFICER, body: { values } });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("officer");
  });

  it("returns problem details for invalid input", async () => {
    const res = await h.call("POST", "/accounts/100000001/reports", {
      ...PLAYER,
      body: { values: [{ metric: "city_power", value: -5 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.title).toMatch(/between/);
  });

  it("applies a correction and ignores the superseded report", async () => {
    const first = await h.call("POST", "/accounts/100000001/reports", {
      ...PLAYER,
      body: { values: [{ metric: "city_power", value: 99_999_999 }] },
    });
    const fix = await h.call("POST", "/accounts/100000001/reports", {
      ...PLAYER,
      body: { values: [{ metric: "city_power", value: 49_999_999 }], supersedesReportId: first.body.reportId },
    });
    expect(fix.status).toBe(201);
    const list = await h.call("GET", "/accounts/100000001/reports", PLAYER);
    expect(list.body.current).toMatchObject({ city_power: { value: 49_999_999 } });
  });

  it("lets a player ignore and restore their own report with an audit reason", async () => {
    const created = await h.call("POST", "/accounts/100000002/reports", {
      ...PLAYER,
      body: { values: [{ metric: "city_power", value: 77_777_777 }] },
    });
    const reportId = String(created.body.reportId);

    const ignored = await h.call("PUT", `/accounts/100000002/reports/${reportId}/ignored`, {
      ...PLAYER,
      headers: { "x-account-id": "100000001" },
      body: { ignored: true, reason: "Typed an extra digit" },
    });
    expect(ignored.status).toBe(200);
    expect(ignored.body).toMatchObject({
      reportId,
      ignoreReason: "Typed an extra digit",
      ignoredBy: "player-1",
      ignoredByName: "Poppy",
    });

    const without = await h.call("GET", "/accounts/100000002/reports", PLAYER);
    expect(without.body.current).toMatchObject({ city_power: { value: 51_000_000 } });

    const restored = await h.call("PUT", `/accounts/100000002/reports/${reportId}/ignored`, {
      ...PLAYER,
      body: { ignored: false, reason: "Checked the screenshot again" },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.ignoredAt).toBeUndefined();

    const current = await h.call("GET", "/accounts/100000002/reports", PLAYER);
    expect(current.body.current).toMatchObject({ city_power: { value: 77_777_777 } });
  });

  it("prevents players from ignoring officer reports, while officers can moderate any report", async () => {
    const created = await h.call("POST", "/accounts/100000001/reports", {
      ...OFFICER,
      body: { values: [{ metric: "city_power", value: 66_000_000 }] },
    });
    const path = `/accounts/100000001/reports/${String(created.body.reportId)}/ignored`;
    expect((await h.call("PUT", path, { ...PLAYER, body: { ignored: true, reason: "Not mine" } })).status).toBe(403);
    const ignored = await h.call("PUT", path, {
      ...PLAYER,
      groups: ["officer"],
      headers: { "x-account-id": "100000001" },
      body: { ignored: true, reason: "Officer correction" },
    });
    expect(ignored.status).toBe(200);
    expect(ignored.body).toMatchObject({ ignoredByName: "Poppy" });
  });
});
