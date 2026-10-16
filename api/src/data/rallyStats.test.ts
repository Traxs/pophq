import { describe, it, expect } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readRallyStats } from "./rallyStats.js";
describe("rally statistics reader",()=>{
 it("reads only the fixed guild record and does not expose internal event IDs",async()=>{
  let input:unknown;
  const db={send:async(command:{input:unknown})=>{input=command.input;return {Item:{data:{version:1,trackingSince:1000,updatedAt:2000,totals:{sessions:1,durationMs:1000,attacks:2,counters:1,incoming:4},recent:[],current:{id:"session",startedAt:1000,lastSeenAt:2000,durationMs:1000,attacks:2,counters:1,incoming:4,seen:["private-event-id"]}}}};}} as unknown as DynamoDBDocumentClient;
  const result=await readRallyStats(db,"rally-table","guild");
  expect(input).toEqual({TableName:"rally-table",Key:{pk:"BATTLE_STATS#guild"},ConsistentRead:false});
  expect(result.totals.attacks).toBe(2);
  expect(result.current).not.toHaveProperty("seen");
 });
 it("does not mistake an absent record for historical zero usage",async()=>{
  const db={send:async()=>({})} as unknown as DynamoDBDocumentClient;
  expect((await readRallyStats(db,"rally-table","guild")).trackingSince).toBeNull();
 });
});

it("reads archived sessions across pages without replacing fresher aggregate summaries",async()=>{
 const row={id:"old",startedAt:1000,lastSeenAt:2000,endedAt:2000,durationMs:1000,attacks:2,counters:1,incoming:4};
 const responses=[{Item:{data:{version:1,trackingSince:1000,updatedAt:3000,totals:{},recent:[{...row,attacks:3}]}}},{Items:[{data:row}],LastEvaluatedKey:{pk:"next"}},{Items:[{data:{...row,id:"older",startedAt:500}}]}];
 const inputs:unknown[]=[];
 const db={send:async(command:{input:unknown})=>{inputs.push(command.input);return responses.shift();}} as unknown as DynamoDBDocumentClient;
 const result=await readRallyStats(db,"rally-table","guild",true);
 expect(result.recent.map(row=>row.id)).toEqual(["old","older"]);
 expect(result.recent[0]?.attacks).toBe(3);
 expect(inputs[2]).toMatchObject({ExclusiveStartKey:{pk:"next"},ExpressionAttributeValues:{":guild":"guild"}});
});
