// Reading the change history. The history table is written only by the stream handler
// (src/ops/historyWriter.ts); nothing here ever changes or deletes an entry.
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { historyKey, type HistoryEntry } from "../ops/history.js";

export interface TimelinePage {
  items: HistoryEntry[];
  /** Pass back as `before` to read older entries. */
  next: string | null;
}

export class HistoryStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /** Changes for one subject (e.g. "ACCOUNT#410691488"), newest first. */
  async timeline(subject: string, limit = 50, before?: string): Promise<TimelinePage> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: before ? "PK = :pk AND SK < :before" : "PK = :pk",
        ExpressionAttributeValues: before
          ? { ":pk": historyKey(subject, "").PK, ":before": before }
          : { ":pk": historyKey(subject, "").PK },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 200),
      }),
    );
    const items = (res.Items ?? []).map((item) => item as unknown as HistoryEntry);
    return { items, next: res.LastEvaluatedKey ? (items.at(-1)?.at ?? null) : null };
  }
}
