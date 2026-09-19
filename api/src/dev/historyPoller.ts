// Local stand-in for the DynamoDB stream that triggers the history writer in AWS.
// DynamoDB Local exposes the same stream API, so the local server polls it and runs exactly
// the same handler code; without this, timelines would only work after a deploy.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from "@aws-sdk/client-dynamodb-streams";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { StreamRecord } from "../ops/history.js";
import { storeEntries } from "../ops/historyWriter.js";

export interface PollerOptions {
  /** DynamoDB Local's address; the streams API lives on the same port. */
  endpoint: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

/** Starts polling; returns a function that stops it. */
export function startHistoryPoller(
  base: DynamoDBClient,
  db: DynamoDBDocumentClient,
  tableName: string,
  { endpoint, intervalMs = 1000, onError = (e) => console.warn("history poller:", String(e)) }: PollerOptions,
): () => void {
  const streams = new DynamoDBStreamsClient({
    region: "eu-central-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const iterators = new Map<string, string>();
  let stopped = false;

  const tick = async () => {
    const table = await base.send(new DescribeTableCommand({ TableName: tableName }));
    const streamArn = table.Table?.LatestStreamArn;
    if (!streamArn) return;
    const described = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }));
    for (const shard of described.StreamDescription?.Shards ?? []) {
      const shardId = shard.ShardId;
      if (!shardId) continue;
      let iterator = iterators.get(shardId);
      if (!iterator) {
        const res = await streams.send(
          new GetShardIteratorCommand({ StreamArn: streamArn, ShardId: shardId, ShardIteratorType: "TRIM_HORIZON" }),
        );
        iterator = res.ShardIterator;
      }
      if (!iterator) continue;
      const records = await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 100 }));
      if (records.Records?.length) {
        await storeEntries(db, tableName, records.Records as StreamRecord[]);
      }
      if (records.NextShardIterator) iterators.set(shardId, records.NextShardIterator);
      else iterators.delete(shardId);
    }
  };

  const loop = setInterval(() => {
    if (stopped) return;
    void tick().catch(onError);
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(loop);
  };
}
