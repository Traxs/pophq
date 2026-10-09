import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import { eventTimeline } from "./eventTimeline";

const item = (changes: Partial<EventListItem>): EventListItem => ({
  eventId: "event-1",
  alliance: "POP",
  kind: "foundry",
  title: "Foundry",
  startsAt: "2026-09-20T19:00:00.000Z",
  deadlineAt: "2026-09-20T18:00:00.000Z",
  sessions: [],
  createdBy: "officer",
  closed: true,
  myAnswer: null,
  mySessionId: null,
  ...changes,
});

describe("event timeline", () => {
  it("orders comparable events oldest first and calculates a scale-independent result share", () => {
    const points = eventTimeline([
      item({ eventId: "new", startsAt: "2026-09-20T19:00:00Z", history: { results: [{ sessionId: "L1", sessionLabel: "L1", outcome: "win", ourScore: 300, opponentScore: 100, participants: 20 }], phases: [] } }),
      item({ eventId: "other", kind: "koi", history: { results: [], phases: [{ phaseKey: "castle_battle", phaseLabel: "Battle", coverage: "partial", scoredPlayers: 2, reportedPlayerSubtotal: 500, scope: "alliance" }] } }),
      item({ eventId: "old", startsAt: "2026-09-06T19:00:00Z", history: { results: [{ sessionId: "L2", sessionLabel: "L2", outcome: "loss", ourScore: 100, opponentScore: 300, participants: 10 }], phases: [] } }),
    ], "foundry", "new");

    expect(points.map((point) => point.eventId)).toEqual(["old", "new"]);
    expect(points[0]).toMatchObject({ performance: 25, losses: 1, participants: 10, current: false });
    expect(points[1]).toMatchObject({ performance: 75, wins: 1, participants: 20, current: true });
  });

  it("keeps preparation and battle totals separate and marks partial coverage", () => {
    const points = eventTimeline([item({
      eventId: "koi",
      kind: "koi",
      history: {
        results: [],
        phases: [
          { phaseKey: "preparation", phaseLabel: "Preparation", coverage: "complete", scoredPlayers: 4, reportedPlayerSubtotal: 800, scope: "alliance" },
          { phaseKey: "castle_battle", phaseLabel: "Battle", coverage: "partial", scoredPlayers: 3, reportedPlayerSubtotal: 600, scope: "alliance" },
        ],
      },
    })], "koi", "koi");

    expect(points[0]).toMatchObject({ preparation: 800, battle: 600, phaseCoverage: "partial", current: true });
  });

  it("uses every alliance score for a three-alliance Canyon share and placement", () => {
    const points = eventTimeline([item({
      eventId: "canyon",
      kind: "canyon",
      history: {
        phases: [],
        results: [{
          sessionId: "L2",
          sessionLabel: "Legion 2",
          outcome: "win",
          ourScore: 550_591,
          opponentScore: 487_805,
          allianceScores: [
            { allianceTag: "POP", allianceName: "POP", isOurAlliance: true, score: 550_591, precision: { kind: "exact" } },
            { allianceTag: "BOS", allianceName: "S", isOurAlliance: false, score: 487_805, precision: { kind: "exact" } },
            { allianceTag: "SOA", allianceName: "SonsOfAnarchy", isOurAlliance: false, score: 486_816, precision: { kind: "exact" } },
          ],
        }],
      },
    })], "canyon", "canyon");

    expect(points[0]).toMatchObject({ alliancePlace: 1, allianceCount: 3, ourScore: 550_591, opponentScore: 487_805 });
    expect(points[0]!.performance).toBeCloseTo(550_591 / (550_591 + 487_805 + 486_816) * 100);
  });
});
