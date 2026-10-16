import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
export interface BattleSummary {
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
export async function readRallyStats(db: DynamoDBDocumentClient, table: string, guild: string): Promise<RallyStatsView> {
  const result=await db.send(new GetCommand({TableName:table,Key:{pk:`BATTLE_STATS#${guild}`},ConsistentRead:false}));
  const data=result.Item?.data;
  if(!data) return emptyRallyStats();
  if(data.version!==1) throw new Error("Unsupported rally statistics format");
  const summary=(row: BattleSummary): BattleSummary => ({id:row.id,startedAt:row.startedAt,lastSeenAt:row.lastSeenAt,...(row.endedAt ? {endedAt:row.endedAt}:{}),durationMs:row.durationMs,attacks:row.attacks,counters:row.counters,incoming:row.incoming});
  return {trackingSince:data.trackingSince,updatedAt:data.updatedAt,totals:data.totals,recent:data.recent.map(summary),current:data.current ? summary(data.current):null};
}
