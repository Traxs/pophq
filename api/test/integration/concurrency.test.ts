// Race conditions from the spec's Failure review: parallel writes, exactly one winner.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import { ConflictError } from "../../src/domain/errors.js";
import { parseReport, type Report } from "../../src/domain/measurements.js";
import { accountKey } from "../../src/data/keys.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
const actor = { id: "test", via: "web" as const };
const N = 12;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.cleanup());

const report = (playerId: string, over: Partial<Report> = {}): Report => ({
  ...parseReport(
    { values: [{ metric: "city_power", value: 1_000_000 }] },
    { playerId, reportId: ulid(), source: "officer", now: new Date() },
  ),
  ...over,
});

/** Runs all attempts at once and counts outcomes. */
async function race(attempts: (() => Promise<unknown>)[]) {
  const results = await Promise.allSettled(attempts.map((f) => f()));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const conflicts = results.filter((r) => r.status === "rejected" && r.reason instanceof ConflictError).length;
  const other = results.filter((r) => r.status === "rejected" && !(r.reason instanceof ConflictError));
  return { ok, conflicts, other };
}

describe("concurrent writes", () => {
  it("creates an account only once when the same Player ID is submitted in parallel", async () => {
    const account = parseNewAccount({ playerId: "300000001", name: "Racer" });
    const outcome = await race(Array.from({ length: N }, () => () => h.repo.createAccount(account, actor)));
    expect(outcome).toEqual({ ok: 1, conflicts: N - 1, other: [] });
  });

  it("links a game account to only one login under parallel requests (ID-12)", async () => {
    await h.repo.createAccount(parseNewAccount({ playerId: "300000002", name: "Linked" }), actor);
    const outcome = await race(
      Array.from({ length: N }, (_, i) => () => h.repo.linkAccount(`login-${i}`, "300000002", actor)),
    );
    expect(outcome).toEqual({ ok: 1, conflicts: N - 1, other: [] });
    const winners = await Promise.all(Array.from({ length: N }, (_, i) => h.repo.linkedAccounts(`login-${i}`)));
    expect(winners.filter((l) => l.length > 0)).toHaveLength(1);
  });

  it("lets only one of several parallel corrections supersede a report", async () => {
    await h.repo.createAccount(parseNewAccount({ playerId: "300000003", name: "Fixer" }), actor);
    const original = report("300000003");
    await h.repo.addReport(original, actor);
    const outcome = await race(
      Array.from(
        { length: N },
        () => () => h.repo.addReport(report("300000003", { supersedesReportId: original.reportId }), actor),
      ),
    );
    expect(outcome).toEqual({ ok: 1, conflicts: N - 1, other: [] });
    const all = await h.repo.listReports("300000003");
    expect(all).toHaveLength(2); // original + exactly one correction
  });

  it("refuses new data for an account that has transferred out (FM-12)", async () => {
    await h.repo.createAccount(parseNewAccount({ playerId: "300000004", name: "Leaver" }), actor);
    await h.db.send(
      new UpdateCommand({
        TableName: h.tableName,
        Key: accountKey("300000004"),
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "transferred_out" },
      }),
    );
    await expect(h.repo.addReport(report("300000004"), actor)).rejects.toThrow(/doesn't accept new data/);
  });
});
