// Lambda behind the main table's stream: stores one history entry per change (DATA-04).
// Writes are conditional on the entry not existing, so a retried batch can't create duplicates.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createDocClient, createBaseClient } from "../data/client.js";
import { historyKey, toHistoryEntry, type HistoryEntry, type StreamRecord } from "./history.js";

export interface WriteResult {
  written: number;
  skipped: number;
}

export async function storeEntries(
  db: DynamoDBDocumentClient,
  table: string,
  records: readonly StreamRecord[],
): Promise<WriteResult> {
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    const entry = toHistoryEntry(record);
    if (!entry) {
      skipped += 1;
      continue;
    }
    try {
      await db.send(
        new PutCommand({
          TableName: table,
          Item: { ...historyKey(entry.subject, entry.at), ...entry } satisfies Record<string, unknown> & HistoryEntry,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      written += 1;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        skipped += 1; // already stored by an earlier attempt
        continue;
      }
      throw err; // the batch is retried, then parked in the dead-letter queue
    }
  }
  return { written, skipped };
}

const table = process.env.HISTORY_TABLE_NAME;
const db = createDocClient(createBaseClient({ tableName: table ?? "unset", region: process.env.AWS_REGION ?? "eu-central-1" }));

export const handler = async (event: { Records?: StreamRecord[] }): Promise<void> => {
  if (!table) throw new Error("HISTORY_TABLE_NAME is not set");
  const result = await storeEntries(db, table, event.Records ?? []);
  console.info(JSON.stringify({ level: "info", message: "history written", ...result }));
};
