import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";
import { parseReport, currentValues } from "../../src/domain/measurements.js";
import type { Group } from "../../src/domain/principal.js";

describe("guarded bot troop reports", () => {
  let h: Harness, token: string, readOnly: string;
  let groups = new Set<Group>(["officer"]);
  const actor = {id: "seed", via: "seed" as const};
  const date = new Date("2026-11-04T12:00:00Z");
  beforeAll(async () => {
    h = await createHarness({now: () => date, botIssuerGroups: async () => groups});
    await h.repo.createAccount({playerId:"800000001",name:"Officer",alliance:"POP",rank:"R4",status:"active"},actor);
    await h.repo.linkAccount("troop-officer","800000001",actor);
    for (const pid of ["800000002","800000003"]) {
      await h.repo.createAccount({playerId:pid,name:"Same name",alliance:"POP",rank:"R1",status:"active"},actor);
      await h.repo.addReport(parseReport({effectiveAt:"2026-11-01T00:00:00Z",values:[{metric:"furnace_level",value:"FC9"},{metric:"helios_lancer",value:true}]},{playerId:pid,reportId:"initial",source:"officer",now:date}),actor);
    }
    for (const scopes of [["all:read","troops:write"],["all:read"]]) {
      const r = await h.call("POST","/agent-tokens",{as:"troop-officer",groups:["officer"],body:{name:"Troops",scopes}});
      expect(r.status).toBe(201);
      if (scopes.includes("troops:write")) token = r.body.token as string; else readOnly = r.body.token as string;
    }
  });
  afterAll(() => h.cleanup());
  const payload = () => ({effectiveAt:"2026-11-04T10:00:00Z",sourceReference:"Officer report in Discord",troops:{infantry:{level:"FC8",helios:true},marksman:{helios:false}}});
  const call = (body: unknown, apply=false, key="troop-test-1", selected=token, pid="800000002") => h.call("POST",`/agent/accounts/${pid}/troops${apply ? "?apply=true" : ""}`,{body,headers:{authorization:`Bearer ${selected}`,"idempotency-key":key}});
  it("previews without writing, applies exact reviewed partial fields and replays once", async () => {
    const body = payload();
    const p = await call(body);
    expect(p.status).toBe(200);
    expect((await h.repo.listReports("800000002")).length).toBe(1);
    const apply = {...body,approved:true,reason:"Confirmed by player",expectedHash:p.body.expectedHash};
    const saved = await call(apply,true);
    expect(saved.status).toBe(201);
    const current = currentValues(await h.repo.listReports("800000002"));
    expect(current.troop_level_infantry?.value).toBe("FC8");
    expect(current.helios_marksman?.value).toBe("no");
    expect(current.helios_lancer?.value).toBe("yes");
    expect((await call(apply,true)).body.replayed).toBe(true);
    expect((await h.repo.listReports("800000002")).length).toBe(2);
    expect((await call(apply,true,"troop-test-1",token,"800000003")).status).toBe(409);
  });
  it("rejects changed previews, unapproved writes, unrelated fields and excessive levels", async () => {
    const body=payload(), p=await call(body);
    expect((await call({...body,reason:"test",expectedHash:p.body.expectedHash},true,"missing-approval")).status).toBe(400);
    expect((await call({...body,troops:{infantry:{level:"FC7"}},approved:true,reason:"test",expectedHash:p.body.expectedHash},true,"changed-payload")).status).toBe(409);
    expect((await call({...body,troops:{infantry:{level:"FC10"}}})).status).toBe(400);
    expect((await call({...body,city_power:500})).status).toBe(400);
    expect((await call({...body,troops:{infantry:{helios:"false"}}})).status).toBe(400);
  });
  it("rejects stale previews after report changes, including ignored reports", async () => {
    const body=payload(), p=await call(body);
    await h.repo.setReportIgnored("800000002","initial",true,{...actor,reason:"Correction"},"Officer");
    expect((await call({...body,approved:true,reason:"test",expectedHash:p.body.expectedHash},true,"stale-preview")).status).not.toBe(201);
    await h.repo.setReportIgnored("800000002","initial",false,{...actor,reason:"Restore"},"Officer");
    expect((await call({...body,approved:true,reason:"test",expectedHash:p.body.expectedHash},true,"stale-restored")).status).toBe(409);
  });
  it("requires explicit scope and current issuer authority, rejects browser tokens and ambiguous names", async () => {
    expect((await call(payload(),false,"readonly-test",readOnly)).status).toBe(403);
    const r = await h.call("POST","/agent/accounts/800000002/troops",{body:payload(),headers:{authorization:`Bearer ${token}`,origin:"https://example.test"}});
    expect(r.status).toBe(403);
    expect((await call(payload(),false,"name-test",token,"Same name")).status).toBe(400);
    const officer = (await h.repo.getAccount("800000001"))!;
    await h.repo.updateAccount({...officer, rank: "R3"}, actor);
    groups=new Set(["player"]);
    expect((await call(payload())).status).toBe(403);
    groups=new Set(["officer"]);
    await h.repo.updateAccount(officer, actor);
  });
  it("requires a known furnace for levels and preserves omitted troop fields", async () => {
    const pid = "800000004";
    await h.repo.createAccount({playerId:pid, name:"No furnace", alliance:"POP", rank:"R1", status:"active"}, actor);
    expect((await call(payload(), false, "missing-furnace", token, pid)).status).toBe(400);
    expect((await call({...payload(), troops:{infantry:{helios:true}}}, false, "helios-only", token, pid)).status).toBe(200);
    expect((await call({...payload(), effectiveAt:"2027-01-01T00:00:00Z"})).status).toBe(400);
  });
  it("atomically fences concurrent report writes without losing the other report", async () => {
    const pid="800000003", revision=await h.repo.reportRevision(pid);
    const report = (id: string) => parseReport({values:[{metric:"helios_infantry",value:true}]},{playerId:pid,reportId:id,source:"hermes",now:date});
    await h.repo.addReport(report("concurrent"),actor);
    const account = (await h.repo.getAccount(pid))!;
    await h.repo.updateAccount({...account, name: "Updated name"}, actor);
    expect(await h.repo.reportRevision(pid)).toBe(revision + 1);
    await expect(h.repo.addReport(report("stale"),actor,{tokenId:"test",key:"race-test",bodyHash:"hash",response:{},revision})).rejects.toThrow(/changed/);
    expect(await h.repo.getReport(pid,"stale")).toBeUndefined();
    expect(await h.repo.getIdempotentChange("test","race-test")).toBeUndefined();
  });
});
