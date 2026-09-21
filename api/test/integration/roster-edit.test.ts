import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

describe("officers keep the roster right", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ history: true });
    await seedDemo(h.repo, new Date());
  });
  afterAll(() => h.cleanup());

  it("sets a rank on an account that came in without one", async () => {
    await h.repo.createAccount(
      { playerId: "700000001", name: "Wenzy", alliance: "POP", status: "unknown" },
      { id: "import", via: "migration" },
    );
    const res = await h.call("PATCH", "/accounts/700000001", { ...OFFICER, body: { rank: "R4", status: "active" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ playerId: "700000001", name: "Wenzy", rank: "R4", status: "active" });
    expect(await h.repo.getAccount("700000001")).toMatchObject({ rank: "R4", status: "active" });
  });

  it("keeps a renamed account in the roster, which is indexed on the name", async () => {
    await h.call("PATCH", "/accounts/700000001", { ...OFFICER, body: { name: "WenzyPorsche" } });
    const roster = await h.call("GET", "/roster", OFFICER);
    const rows = roster.body.items as { playerId: string; name: string }[];
    const found = rows.filter((r) => r.playerId === "700000001");
    // Exactly one row, under the new name: the old index entry must not linger.
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("WenzyPorsche");
  });

  it("stamps the change with who made it and why, which is what the history stream picks up", async () => {
    await h.call("PATCH", "/accounts/700000001", { ...OFFICER, body: { note: "Runs the Foundry" } });
    // Read the raw item: the timeline itself is written by the stream handler, which does not
    // run in these tests (it has its own suite), so this checks the part the route controls.
    const item = await h.db.send(
      new GetCommand({ TableName: h.tableName, Key: { PK: "ACCOUNT#700000001", SK: "PROFILE" } }),
    );
    expect(item.Item).toMatchObject({ note: "Runs the Foundry", via: "web", reason: "roster edit" });
    expect(String(item.Item?.updatedBy)).toBe("officer");
  });

  it("moves someone to another alliance only as a guest", async () => {
    expect((await h.call("PATCH", "/accounts/700000001", { ...OFFICER, body: { alliance: "MIR" } })).status).toBe(400);
    const ok = await h.call("PATCH", "/accounts/700000001", {
      ...OFFICER,
      body: { alliance: "MIR", status: "guest" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ alliance: "MIR", status: "guest" });
  });

  it("stops data reaching an account that transferred out", async () => {
    await h.repo.createAccount(
      { playerId: "700000002", name: "Gone", alliance: "POP", status: "active" },
      { id: "t", via: "migration" },
    );
    await h.call("PATCH", "/accounts/700000002", { ...OFFICER, body: { status: "transferred_out" } });
    const report = await h.call("POST", "/accounts/700000002/reports", {
      ...OFFICER,
      body: { values: [{ metric: "city_power", value: 1_000_000 }] },
    });
    expect(report.status).toBe(409);
  });

  it("refuses members, unknown accounts and changes that say nothing", async () => {
    expect((await h.call("PATCH", "/accounts/700000001", { ...PLAYER, body: { rank: "R5" } })).status).toBe(403);
    expect((await h.call("PATCH", "/accounts/999999999", { ...OFFICER, body: { rank: "R5" } })).status).toBe(404);
    expect((await h.call("PATCH", "/accounts/700000001", { ...OFFICER, body: {} })).status).toBe(400);
  });
});
