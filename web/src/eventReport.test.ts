import { describe, expect, it } from "vitest";
import type { EventDetail, EventMember } from "./api";
import { completedEventRows } from "./eventReport";

const member = (playerId: string, changes: Partial<EventMember> = {}): EventMember => ({
  playerId,
  name: playerId,
  rank: null,
  answer: null,
  sessionId: null,
  answeredAt: null,
  attended: null,
  lineup: null,
  strengthTrend: [],
  attendanceTrend: [],
  power: null,
  foundryStrength: null,
  furnace: null,
  troops: {
    infantry: { level: null, helios: null },
    lancer: { level: null, helios: null },
    marksman: { level: null, helios: null },
  },
  troopReportAt: null,
  lastReportAt: null,
  ...changes,
});

const event = (): EventDetail => ({
  eventId: "FOUND-1",
  alliance: "POP",
  kind: "foundry",
  title: "Foundry",
  startsAt: "2026-09-20T19:00:00.000Z",
  deadlineAt: "2026-09-20T18:00:00.000Z",
  createdBy: "officer",
  closed: true,
  myAnswer: null,
  mySessionId: null,
  counts: { yes: 2, no: 0, maybe: 0, pending: 1, bySession: { L2: 2 } },
  sessions: [{
    id: "L2",
    label: "Legion 2",
    startsAt: "2026-09-20T19:00:00.000Z",
    signedUp: 2,
    spotsLeft: null,
    signedUpList: [],
    lineup: null,
    strategy: null,
    result: {
      version: 1,
      outcome: "loss",
      ourScore: 212122,
      opponentScore: 328452,
      recordedAt: "2026-09-21T00:00:00.000Z",
      playerPoints: [{ playerId: "1", name: "One", points: 1234 }],
    },
  }],
  members: [
    member("1", { name: "One", answer: "yes", sessionId: "L2" }),
    member("2", { name: "Two", answer: "yes", sessionId: "L2", attended: "absent" }),
    member("3", { name: "Three" }),
  ],
});

describe("completed event report", () => {
  it("uses a positive score as attendance evidence and keeps missing evidence unreviewed", () => {
    const rows = completedEventRows(event());
    expect(rows.map((row) => [row.member.name, row.attendance, row.attendanceEvidence])).toEqual([
      ["One", "present", "score"],
      ["Two", "absent", "record"],
      ["Three", "unrecorded", null],
    ]);
    expect(rows[0]).toMatchObject({ answerLabel: "Legion 2", sessionScores: [{ label: "Legion 2", points: 1234 }], hasEventRecord: true });
    expect(rows[2]?.hasEventRecord).toBe(false);
  });

  it("shows phase scores and treats positive phase points as event participation", () => {
    const detail = event();
    detail.kind = "koi";
    detail.scoreboards = {
      preparation: { phaseKey: "preparation", phaseLabel: "Preparation", version: 1, coverage: "partial", scoredPlayers: 1, reportedPlayerSubtotal: 50, entries: [{ playerId: "3", name: "Three", points: 50, mine: false }] },
      castle_battle: { phaseKey: "castle_battle", phaseLabel: "Castle battle", version: 1, coverage: "partial", scoredPlayers: 1, reportedPlayerSubtotal: 80, entries: [{ playerId: "2", name: "Two", points: 80, mine: false }] },
    };
    const rows = completedEventRows(detail);
    expect(rows.find((row) => row.member.playerId === "2")).toMatchObject({ attendance: "present", castleBattlePoints: 80 });
    expect(rows.find((row) => row.member.playerId === "3")).toMatchObject({ attendance: "present", preparationPoints: 50 });
  });

  it("trusts an approved officer-bot result row even when its individual score is zero", () => {
    const detail = event();
    detail.sessions[0]!.result!.playerPoints = [{ playerId: "2", name: "Two", points: 0 }];
    detail.members![1] = member("2", { name: "Two", attendedByScore: true });
    expect(completedEventRows(detail).find((row) => row.member.playerId === "2")).toMatchObject({
      attendance: "present",
      attendanceEvidence: "score",
      sessionScores: [{ points: 0 }],
    });
  });
});
