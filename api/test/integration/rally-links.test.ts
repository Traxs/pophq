import {afterAll,beforeAll,expect,it} from "vitest";
import {createHarness,type Harness} from "./harness.js";
let h:Harness;
const officer={as:"officer",groups:["officer"]};
const battle={id:"battle",startedAt:1000,lastSeenAt:2000,endedAt:2000,durationMs:1000,attacks:3,counters:2,incoming:4};
beforeAll(async()=>{
 h=await createHarness({rallyStats:{trackingSince:1000,updatedAt:2000,totals:{sessions:1,durationMs:1000,attacks:3,counters:2,incoming:4},recent:[battle],current:null}});
 for(const id of ["event-one","event-two"]) await h.repo.createEvent({eventId:id,alliance:"POP",kind:"svs",title:id,startsAt:"2026-10-16T12:00:00.000Z",deadlineAt:"2026-10-16T11:00:00.000Z",sessions:[],createdBy:"officer"},{id:"officer",via:"web"});
});
afterAll(()=>h.cleanup());
it("only officers can link known battles to existing events",async()=>{
 expect((await h.call("PUT","/metrics/rallies/battle/event",{as:"player",body:{eventId:"event-one"}})).status).toBe(403);
 expect((await h.call("PUT","/metrics/rallies/missing/event",{...officer,body:{eventId:"event-one"}})).status).toBe(404);
 expect((await h.call("PUT","/metrics/rallies/battle/event",{...officer,body:{eventId:"missing"}})).status).toBe(404);
 expect((await h.call("PUT","/metrics/rallies/battle/event",{...officer,body:{eventId:42}})).status).toBe(400);
});
it("saves, corrects and removes links without changing battle statistics",async()=>{
 for(const eventId of ["event-one","event-two",null]) {
  expect((await h.call("PUT","/metrics/rallies/battle/event",{...officer,body:{eventId}})).status).toBe(200);
  const result=await h.call("GET","/metrics/rallies",officer);
  expect(result.body.recent).toEqual([expect.objectContaining({...battle,eventId,linkedBy:"officer"})]);
  expect((await h.repo.rallyEventLinks())[0]?.eventId).toBe(eventId);
 }
});

it("offers lightweight event choices only to officers",async()=>{
 expect((await h.call("GET","/metrics/rallies/events",{as:"player"})).status).toBe(403);
 const response=await h.call("GET","/metrics/rallies/events",officer);
 expect(response.status).toBe(200);
 expect(response.body.items).toEqual(expect.arrayContaining([{eventId:"event-one",title:"event-one",startsAt:"2026-10-16T12:00:00.000Z"}]));
});
