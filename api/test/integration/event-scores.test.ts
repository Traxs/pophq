import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

describe("SvS and KOI scoreboards", () => {
  let h: Harness;
  let eventId: string;
  let foundryId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const startsAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const koi = await h.call("POST", "/events", { ...OFFICER, body: { kind: "koi", title: "King of Icefield", startsAt } });
    eventId = koi.body.eventId as string;
    const foundry = await h.call("POST", "/events", { ...OFFICER, body: { kind: "foundry", title: "Foundry", startsAt } });
    foundryId = foundry.body.eventId as string;
  });

  afterAll(() => h.cleanup());

  it("lets a player report only their own scores in each phase", async () => {
    expect((await h.call("PUT", `/events/${eventId}/phases/preparation/scores/100000001`, { ...PLAYER, body: { points: 450_000 } })).status).toBe(200);
    expect((await h.call("PUT", `/events/${eventId}/phases/castle_battle/scores/100000001`, { ...PLAYER, body: { points: 125_000 } })).status).toBe(200);
    expect((await h.call("PUT", `/events/${eventId}/phases/preparation/scores/100000008`, { ...PLAYER, body: { points: 1 } })).status).toBe(403);
  });

  it("limits scoreboards to SvS and KOI", async () => {
    expect((await h.call("PUT", `/events/${foundryId}/phases/preparation/scores/100000001`, { ...PLAYER, body: { points: 1 } })).status).toBe(400);
  });

  it("lets officers import partial scores and preserves omitted self-reports", async () => {
    const imported = await h.call("POST", `/events/${eventId}/phases/preparation/scores/import`, {
      ...OFFICER,
      body: { expectedVersion: 1, coverage: "partial", playerPoints: [{ playerId: "100000005", points: 900_000 }], source: { type: "officer_import" } },
    });
    expect(imported).toMatchObject({ status: 200, body: { imported: 1, version: 2 } });

    const officerDetail = await h.call("GET", `/events/${eventId}`, OFFICER);
    expect(officerDetail.body.scoreboards).toMatchObject({
      preparation: { entries: [
        { rank: 1, playerId: "100000005", points: 900_000 },
        { rank: 2, playerId: "100000001", points: 450_000 },
      ] },
      castle_battle: { entries: [{ rank: 1, playerId: "100000001", points: 125_000 }] },
    });
    const memberDetail = await h.call("GET", `/events/${eventId}`, PLAYER);
    const preparation = (memberDetail.body.scoreboards as { preparation: { entries: { playerId: string; rank?: number }[] } }).preparation;
    expect(preparation.entries).toEqual([expect.objectContaining({ playerId: "100000001" })]);
    expect(preparation.entries[0]?.rank).toBeUndefined();
    expect(JSON.stringify(memberDetail.body)).not.toContain("100000005");
  });

  it("validates versions and alliance membership", async () => {
    expect((await h.call("POST", `/events/${eventId}/phases/castle_battle/scores/import`, {
      ...OFFICER,
      body: { expectedVersion: 0, coverage: "partial", playerPoints: [{ playerId: "100000001", points: 1 }], source: { type: "officer_import" } },
    })).status).toBe(409);
    expect((await h.call("POST", `/events/${eventId}/phases/castle_battle/scores/import`, {
      ...OFFICER,
      body: { expectedVersion: 1, coverage: "partial", playerPoints: [{ playerId: "999999999", points: 1 }], source: { type: "officer_import" } },
    })).status).toBe(400);
  });
});
