import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
export interface BattleSummary {
  eventId?: string | null; linkedBy?: string; linkedAt?: string;
  id: string; startedAt: number; lastSeenAt: number; endedAt?: number;
  durationMs: number; attacks: number; counters: number; incoming: number;
}
export interface RallyStatsView {
  trackingSince: number | null; updatedAt: number | null;
  totals: { sessions: number; durationMs: number; attacks: number; counters: number; incoming: number };
  recent: BattleSummary[]; current: BattleSummary | null;
}
export function emptyRallyStats(): RallyStatsView {
  return {trackingSince:null, updatedAt:null,totals:{sessions:0,durationMs:0,attacks:0,counters:0,incoming:0},recent:[],current:null};
}
export async function readRallyStats(db: DynamoDBDocumentClient, table: string, guild: string, archive = false): Promise<RallyStatsView> {
  const result=await db.send(new GetCommand({TableName:table,Key:{pk:`BATTLE_STATS#${guild}`},ConsistentRead:false}));
  const data=result.Item?.data;
  if(!data) return emptyRallyStats();
  if(data.version!==1) throw new Error("Unsupported rally statistics format");
  const summary=(row: BattleSummary): BattleSummary => ({id:row.id,startedAt:row.startedAt,lastSeenAt:row.lastSeenAt,...(row.endedAt ? {endedAt:row.endedAt}:{}),durationMs:row.durationMs,attacks:row.attacks,counters:row.counters,incoming:row.incoming});
  const rows = new Map<string, BattleSummary>(data.recent.map((row: BattleSummary) => [row.id, summary(row)]));
  if (archive) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new QueryCommand({TableName:table,IndexName:"BattleSessions",
        KeyConditionExpression:"statsGuild = :guild",ExpressionAttributeValues:{":guild":guild},
        ...(cursor ? {ExclusiveStartKey:cursor} : {})}));
      for (const item of page.Items ?? []) {
        const row = summary(item.data);
        if (row.id !== data.current?.id && row.endedAt && !rows.has(row.id)) rows.set(row.id,row);
      }
      cursor=page.LastEvaluatedKey;
    } while(cursor);
  }
  return {trackingSince:data.trackingSince,updatedAt:data.updatedAt,totals:data.totals,recent:[...rows.values()].sort((a,b)=>b.startedAt-a.startedAt),current:data.current ? summary(data.current):null};
}
