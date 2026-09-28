import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewAccount } from "../../src/domain/accounts.js";
import type { AllianceEvent } from "../../src/domain/events.js";
import { createHarness, type Harness } from "./harness.js";

const R4 = { as: "officer", groups: ["officer"] };
const KILWA_ID = "400674007";

describe("zero-point attendance evidence", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    const actor = { id: "fixture", via: "seed" as const };
    await h.repo.createAccount(parseNewAccount({ playerId: KILWA_ID, name: "KILWA" }), actor);
    await h.repo.createAccount(parseNewAccount({ playerId: "400674008", name: "Officer", rank: "R4" }), actor);
    await h.repo.linkAccount("officer", "400674008", actor);

    const foundry = (eventId: string, startsAt: string): AllianceEvent => ({
      eventId,
      alliance: "POP",
      kind: "foundry",
      title: `Foundry ${startsAt.slice(0, 10)}`,
      startsAt,
      deadlineAt: new Date(Date.parse(startsAt) - 3 * 86_400_000).toISOString(),
      sessions: [{ id: "L1", label: "Legion 1", startsAt }],
      createdBy: "fixture",
    });

    const first = foundry("KILWA-FOUNDRY-1", new Date(Date.now() - 21 * 86_400_000).toISOString());
    const second = foundry("KILWA-FOUNDRY-2", new Date(Date.now() - 7 * 86_400_000).toISOString());
    await h.repo.createEvent(first, actor);
    await h.repo.createEvent(second, actor);

    await h.repo.setAttendance(
      { eventId: first.eventId, playerId: KILWA_ID, sessionId: "L1", status: "absent", source: "officer" },
      actor,
    );
    await h.repo.setAnswer(
      second,
      KILWA_ID,
      { answer: "yes", sessionId: "L1" },
      "import",
      actor,
      undefined,
      { historic: true, answeredAt: second.deadlineAt },
    );

    for (const event of [first, second]) {
      await h.repo.putResult({
        eventId: event.eventId,
        sessionId: "L1",
        version: 1,
        outcome: "loss",
        ourScore: 1,
        opponentScore: 2,
        playerPoints: [{ playerId: KILWA_ID, points: 0 }],
        recordedAt: event.startsAt,
        recordedBy: "agent:fixture",
      }, actor);
    }

    const koiStartsAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const koi: AllianceEvent = {
      eventId: "KILWA-KOI",
      alliance: "POP",
      kind: "koi",
      title: "King of Icefield",
      startsAt: koiStartsAt,
      deadlineAt: new Date(Date.parse(koiStartsAt) - 3 * 3_600_000).toISOString(),
      sessions: [],
      createdBy: "fixture",
    };
    await h.repo.createEvent(koi, actor);
    await h.repo.putEventPhaseScores({
      eventId: koi.eventId,
      phaseKey: "castle_battle",
      phaseLabel: "Castle battle phase",
      version: 1,
      coverage: "partial",
      playerPoints: [{ playerId: KILWA_ID, points: 0 }],
      source: { type: "fixture" },
      recordedAt: koiStartsAt,
      recordedBy: "agent:fixture",
    }, actor);
  });

  afterAll(() => h.cleanup());

  it("does not turn trusted zero rows into attendance", async () => {
    const response = await h.call("GET", "/reward-eligibility", R4);
    expect(response.status).toBe(200);
    const kilwa = (response.body.items as Record<string, unknown>[])
      .find((item) => item.playerId === KILWA_ID);

    expect(kilwa).toMatchObject({
      participationRate: 0,
      participationSample: 2,
      participationAttended: 0,
      participationNoShows: 1,
      participationUnregistered: 1,
    });
  });
});
