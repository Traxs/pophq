// Change history (DATA-02, DATA-04). Every write to the main table arrives here through the
// stream and is stored once, for good: what changed, when, who did it and how. Nothing is
// updated or deleted, so a timeline can always be replayed, and a correction never hides the
// value it replaced.

import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

/**
 * History entries carry their own key prefix, so they never collide with the items they
 * describe (in AWS they live in their own table; locally they share one).
 */
export const historyKey = (subject: string, at: string) => ({ PK: `HIST#${subject}`, SK: at });

/**
 * The part of a DynamoDB stream record this code needs. Images arrive in DynamoDB's own
 * attribute format ({ "S": "text" }), both in AWS and from DynamoDB Local, and are unpacked here.
 */
export interface StreamRecord {
  eventName?: string | undefined;
  dynamodb?:
    | {
        Keys?: Record<string, AttributeValue> | undefined;
        NewImage?: Record<string, AttributeValue> | undefined;
        OldImage?: Record<string, AttributeValue> | undefined;
        ApproximateCreationDateTime?: number | Date | undefined;
        SequenceNumber?: string | undefined;
      }
    | undefined;
}

export interface HistoryEntry {
  /** The thing that changed, e.g. "ACCOUNT#410691488"; its changes form one timeline. */
  subject: string;
  /** Sort key: when it was recorded plus the change id, so entries stay unique and ordered. */
  at: string;
  changeId: string;
  action: "created" | "updated" | "deleted";
  itemType: string;
  /** Item key inside the subject, e.g. "REPORT#01J…" or "PROFILE". */
  itemKey: string;
  version: number | null;
  by: string | null;
  via: string | null;
  reason: string | null;
  /** Fields that differ, with both values. Empty for a creation or deletion. */
  changed: Record<string, { from: unknown; to: unknown }>;
  /** The item after the change (before it, for a deletion). */
  snapshot: Record<string, unknown>;
}

/** Bookkeeping fields: interesting as attribution, not as "what changed". */
const META_FIELDS = new Set([
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "version",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "via",
  "changeId",
  "reason",
]);

const ACTIONS: Record<string, HistoryEntry["action"]> = {
  INSERT: "created",
  MODIFY: "updated",
  REMOVE: "deleted",
};

/**
 * Unpacks a stream image. A single attribute the SDK cannot read (DynamoDB Local returns an
 * empty map that way) must not cost us the whole batch, so those are skipped, not thrown.
 */
function plainImage(values: Record<string, AttributeValue> | undefined): Record<string, unknown> | undefined {
  if (!values) return undefined;
  try {
    return unmarshall(values);
  } catch {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      try {
        out[key] = unmarshall({ value } as Record<string, AttributeValue>).value;
      } catch {
        /* unreadable attribute: left out rather than losing the record */
      }
    }
    return out;
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Compares the item before and after, ignoring bookkeeping fields. */
export function diff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, { from: unknown; to: unknown }> {
  if (!before || !after) return {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (META_FIELDS.has(key)) continue;
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from: from ?? null, to: to ?? null };
  }
  return changed;
}

const creationTime = (value: number | Date | undefined): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  return undefined;
};

/**
 * Turns one stream record into a history entry. Returns undefined for records that carry no
 * history: counters, the seat items and the local development logins.
 */
export function toHistoryEntry(record: StreamRecord, fallbackNow: () => Date = () => new Date()): HistoryEntry | undefined {
  const action = ACTIONS[record.eventName ?? ""];
  const data = record.dynamodb;
  if (!action || !data) return undefined;

  const oldImage = plainImage(data.OldImage);
  const newImage = plainImage(data.NewImage);
  const image = (action === "deleted" ? oldImage : newImage) ?? {};
  const keys = plainImage(data.Keys) ?? {};
  const subject = str(keys.PK) ?? str(image.PK);
  const itemKey = str(keys.SK) ?? str(image.SK) ?? "PROFILE";
  if (!subject) return undefined;

  // History entries are never themselves history: locally they share the table, and a loop
  // would grow without end.
  if (subject.startsWith("HIST#")) return undefined;

  const itemType = str(image.type) ?? (itemKey === "PROFILE" ? "account" : "item");
  if (["seat", "dev-login", "counter"].includes(itemType) || subject === "SEATS") return undefined;

  const at = str(image.updatedAt) ?? creationTime(data.ApproximateCreationDateTime) ?? fallbackNow().toISOString();
  const changeId = str(image.changeId) ?? data.SequenceNumber ?? `${at}#${itemKey}`;

  return {
    subject,
    at: `${at}#${changeId}`,
    changeId,
    action,
    itemType,
    itemKey,
    version: typeof image.version === "number" ? image.version : null,
    by: str(image.updatedBy),
    via: str(image.via),
    reason: str(image.reason),
    changed: diff(oldImage, newImage),
    snapshot: Object.fromEntries(Object.entries(image).filter(([k]) => !["PK", "SK", "GSI1PK", "GSI1SK"].includes(k))),
  };
}
