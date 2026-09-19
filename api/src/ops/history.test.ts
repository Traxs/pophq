import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { diff, toHistoryEntry, type StreamRecord } from "./history.js";

/** Stream records carry DynamoDB attribute values, so the fixtures are marshalled like the real ones. */
const image = (item: Record<string, unknown>) => marshall(item, { removeUndefinedValues: true });

const now = () => new Date("2026-09-19T12:00:00Z");

const record = (over: Partial<StreamRecord> & { dynamodb?: StreamRecord["dynamodb"] }): StreamRecord => ({
  eventName: "MODIFY",
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
  PK: "ACCOUNT#410691488",
  SK: "PROFILE",
  type: "account",
  playerId: "410691488",
  name: "Traxes",
  rank: "R4",
  status: "active",
  version: 2,
  updatedAt: "2026-09-19T11:30:00.000Z",
  updatedBy: "officer-1",
  via: "web",
  changeId: "01J0CHANGE",
  ...over,
});

describe("diff", () => {
  it("reports only real changes, not bookkeeping fields", () => {
    const before = account();
    const after = account({ rank: "R5", version: 3, updatedAt: "2026-09-19T12:00:00.000Z", changeId: "01J0NEW" });
    expect(diff(before, after)).toEqual({ rank: { from: "R4", to: "R5" } });
  });

  it("treats a missing field as null on either side", () => {
    expect(diff(account({ rank: undefined }), account())).toEqual({ rank: { from: null, to: "R4" } });
    expect(diff(account(), account({ rank: undefined }))).toEqual({ rank: { from: "R4", to: null } });
  });

  it("compares nested values by content", () => {
    const values = [{ metric: "city_power", value: 1 }];
    expect(diff(account({ values }), account({ values: [{ metric: "city_power", value: 1 }] }))).toEqual({});
    expect(diff(account({ values }), account({ values: [{ metric: "city_power", value: 2 }] }))).toMatchObject({
      values: expect.anything(),
    });
  });

  it("returns nothing for a creation or deletion", () => {
    expect(diff(undefined, account())).toEqual({});
    expect(diff(account(), undefined)).toEqual({});
  });
});

describe("toHistoryEntry", () => {
  it("records a change with who, when, how and what", () => {
    const entry = toHistoryEntry(
      record({
        eventName: "MODIFY",
        dynamodb: {
          Keys: image({ PK: "ACCOUNT#410691488", SK: "PROFILE" }),
          OldImage: image(account()),
          NewImage: image(account({ rank: "R5", version: 3, updatedAt: "2026-09-19T12:00:00.000Z", changeId: "01J0NEW", reason: "promoted" })),
        },
      }),
      now,
    )!;
    expect(entry).toMatchObject({
      subject: "ACCOUNT#410691488",
      at: "2026-09-19T12:00:00.000Z#01J0NEW",
      action: "updated",
      itemType: "account",
      itemKey: "PROFILE",
      version: 3,
      by: "officer-1",
      via: "web",
      reason: "promoted",
      changed: { rank: { from: "R4", to: "R5" } },
    });
    expect(entry.snapshot).toMatchObject({ name: "Traxes", rank: "R5" });
    expect(entry.snapshot.PK).toBeUndefined();
  });

  it("records creations and deletions with the right action and image", () => {
    const created = toHistoryEntry(
      record({ eventName: "INSERT", dynamodb: { Keys: image({ PK: "ACCOUNT#1", SK: "PROFILE" }), NewImage: image(account()) } }),
      now,
    )!;
    expect(created).toMatchObject({ action: "created", changed: {} });
    expect(created.snapshot.name).toBe("Traxes");

    const deleted = toHistoryEntry(
      record({ eventName: "REMOVE", dynamodb: { Keys: image({ PK: "ACCOUNT#1", SK: "PROFILE" }), OldImage: image(account()) } }),
      now,
    )!;
    expect(deleted).toMatchObject({ action: "deleted" });
    expect(deleted.snapshot.name).toBe("Traxes"); // the deleted item is kept
  });

  it("keeps event answers and reports as their own timeline entries", () => {
    const answer = toHistoryEntry(
      record({
        eventName: "MODIFY",
        dynamodb: {
          Keys: image({ PK: "EVENT#01J0EVENT", SK: "ANSWER#410691488" }),
          OldImage: image({ type: "event-answer", answer: "yes", updatedAt: "2026-09-19T10:00:00.000Z", changeId: "a" }),
          NewImage: image({ type: "event-answer", answer: "no", updatedAt: "2026-09-19T11:00:00.000Z", changeId: "b", updatedBy: "login-1" }),
        },
      }),
      now,
    )!;
    expect(answer).toMatchObject({
      subject: "EVENT#01J0EVENT",
      itemKey: "ANSWER#410691488",
      itemType: "event-answer",
      changed: { answer: { from: "yes", to: "no" } },
    });
  });

  it("skips records that are not history: seats, counters and local logins", () => {
    for (const [pk, type] of [
      ["LOGIN#sub-1", "seat"],
      ["SEATS", "counter"],
      ["DEVLOGIN#a@b.c", "dev-login"],
    ] as const) {
      const skipped = toHistoryEntry(
        record({ eventName: "INSERT", dynamodb: { Keys: image({ PK: pk, SK: "X" }), NewImage: image({ PK: pk, SK: "X", type }) } }),
        now,
      );
      expect(skipped, pk).toBeUndefined();
    }
  });

  it("ignores records it cannot read", () => {
    expect(toHistoryEntry(record({ eventName: "UNKNOWN", dynamodb: { Keys: {} } }), now)).toBeUndefined();
    expect(toHistoryEntry(record({ eventName: "INSERT" }), now)).toBeUndefined();
    expect(toHistoryEntry(record({ eventName: "INSERT", dynamodb: { NewImage: image({ type: "account" }) } }), now)).toBeUndefined();
  });

  it("falls back to the stream's own time and sequence number", () => {
    const entry = toHistoryEntry(
      record({
        eventName: "INSERT",
        dynamodb: {
          Keys: image({ PK: "ACCOUNT#1", SK: "PROFILE" }),
          NewImage: image({ type: "account", name: "NoMeta" }),
          ApproximateCreationDateTime: 1789200000,
          SequenceNumber: "000000000000000000001",
        },
      }),
      now,
    )!;
    expect(entry.at).toBe("2026-09-12T08:00:00.000Z#000000000000000000001");
  });
});

describe("toHistoryEntry: robustness", () => {
  it("never records history about history", () => {
    const entry = toHistoryEntry(
      record({
        eventName: "INSERT",
        dynamodb: {
          Keys: image({ PK: "HIST#ACCOUNT#410691488", SK: "2026-09-19T10:00:00.000Z#c1" }),
          NewImage: image({ subject: "ACCOUNT#410691488", action: "updated" }),
        },
      }),
      now,
    );
    expect(entry).toBeUndefined();
  });

  it("keeps the record when one attribute cannot be read", () => {
    const broken = { ...image(account({ rank: "R5" })), changed: {} as never };
    const entry = toHistoryEntry(
      record({
        eventName: "MODIFY",
        dynamodb: { Keys: image({ PK: "ACCOUNT#410691488", SK: "PROFILE" }), OldImage: image(account()), NewImage: broken },
      }),
      now,
    )!;
    expect(entry.changed.rank).toEqual({ from: "R4", to: "R5" });
    expect(entry.snapshot.name).toBe("Traxes");
  });
});
