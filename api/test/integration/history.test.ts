import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBaseClient, createDocClient } from "../../src/data/client.js";
import { createTable, deleteTable } from "../../src/data/table.js";
import { storeEntries } from "../../src/ops/historyWriter.js";
import type { StreamRecord } from "../../src/ops/history.js";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ulid } from "ulid";
import { createHarness } from "./harness.js";

const config = {
  tableName: `pophq-history-${ulid().toLowerCase()}`,
  region: "eu-central-1",
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
};

const change = (rank: string, changeId: string, at: string): StreamRecord => ({
  eventName: "MODIFY",
  dynamodb: {
    Keys: marshall({ PK: "ACCOUNT#410691488", SK: "PROFILE" }),
    OldImage: marshall({ type: "account", name: "Traxes", rank: "R3", updatedAt: "2026-09-18T10:00:00.000Z", changeId: "old" }),
    NewImage: marshall({
      type: "account",
      name: "Traxes",
      rank,
      version: 3,
      updatedAt: at,
      updatedBy: "officer-1",
      via: "web",
      changeId,
    }),
  },
});

describe("history writer", () => {
  const base = createBaseClient(config);
  const db = createDocClient(base);

  beforeAll(async () => {
    await createTable(base, config.tableName);
  });
  afterAll(async () => {
    await deleteTable(base, config.tableName);
  });

  it("stores one entry per change and ignores repeats of the same change", async () => {
    const records = [change("R4", "change-1", "2026-09-19T10:00:00.000Z"), change("R5", "change-2", "2026-09-19T11:00:00.000Z")];
    expect(await storeEntries(db, config.tableName, records)).toEqual({ written: 2, skipped: 0 });
    // A retried batch must not duplicate anything.
    expect(await storeEntries(db, config.tableName, records)).toEqual({ written: 0, skipped: 2 });
  });

  it("skips records that carry no history", async () => {
    const seat: StreamRecord = {
      eventName: "INSERT",
      dynamodb: { Keys: marshall({ PK: "LOGIN#sub-1", SK: "SEAT" }), NewImage: marshall({ type: "seat" }) },
    };
    expect(await storeEntries(db, config.tableName, [seat])).toEqual({ written: 0, skipped: 1 });
  });
});

describe("GET /v1/accounts/:pid/timeline", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    h = await createHarness({ history: true });
    await h.repo.createAccount(
      { playerId: "410691488", name: "Traxes", alliance: "POP", rank: "R3", status: "active" },
      { id: "officer-1", via: "web" },
    );
    await h.repo.linkAccount("player", "410691488", { id: "officer-1", via: "web" });
    // Two changes, as the stream handler would store them.
    await storeEntries(h.db, h.tableName, [
      change("R4", "change-1", "2026-09-19T10:00:00.000Z"),
      change("R5", "change-2", "2026-09-19T11:00:00.000Z"),
    ]);
  });
  afterAll(() => h.cleanup());

  it("shows an account's own changes, newest first", async () => {
    const res = await h.call("GET", "/accounts/410691488/timeline", { as: "player" });
    expect(res.status).toBe(200);
    const items = res.body.items as { changed: Record<string, { from: string; to: string }>; by: string; via: string }[];
    expect(items).toHaveLength(2);
    expect(items[0]?.changed.rank).toEqual({ from: "R3", to: "R5" });
    expect(items[0]).toMatchObject({ by: "officer-1", via: "web" });
    expect(items[1]?.changed.rank).toEqual({ from: "R3", to: "R4" });
  });

  it("lets officers read any account, but members only their own", async () => {
    expect((await h.call("GET", "/accounts/410691488/timeline", { as: "other" })).status).toBe(403);
    expect((await h.call("GET", "/accounts/410691488/timeline", { as: "boss", groups: ["officer"] })).status).toBe(200);
  });

  it("pages with `before` and reports an unknown account", async () => {
    const page = await h.call("GET", "/accounts/410691488/timeline?limit=1", { as: "player" });
    const first = (page.body.items as { at: string }[])[0]!;
    const older = await h.call("GET", `/accounts/410691488/timeline?before=${encodeURIComponent(first.at)}`, { as: "player" });
    expect((older.body.items as { at: string }[])[0]?.at).not.toBe(first.at);
    expect((await h.call("GET", "/accounts/999999999/timeline", { as: "boss", groups: ["officer"] })).status).toBe(404);
  });
});
