import { describe, expect, it } from "vitest";
import type { EventDetail, EventMember } from "./api";
import { withEventAnswer } from "./eventAnswers";

const member = (playerId: string, answer: EventMember["answer"] = null): EventMember => ({
  playerId,
  name: playerId,
  rank: null,
  answer,
  sessionId: null,
  answeredAt: null,
  attended: null,
  lineup: null,
  strengthTrend: [],
  attendanceTrend: [],
  power: null,
  foundryStrength: null,
  furnace: null,
  lastReportAt: null,
});

const detail = (): EventDetail => ({
  eventId: "KOI-1",
  alliance: "POP",
  kind: "koi",
  title: "King of Icefield",
  startsAt: "2026-09-26T10:00:00.000Z",
  deadlineAt: "2026-09-26T07:00:00.000Z",
  createdBy: "officer",
  closed: false,
  myAnswer: null,
  mySessionId: null,
  sessions: [
    { id: "full", label: "Full time", startsAt: "2026-09-26T10:00:00.000Z", signedUp: 0, spotsLeft: null, signedUpList: [], lineup: null, strategy: null },
    { id: "first", label: "First half", startsAt: "2026-09-26T10:00:00.000Z", signedUp: 0, spotsLeft: null, signedUpList: [], lineup: null, strategy: null },
    { id: "last", label: "Last half", startsAt: "2026-09-26T13:00:00.000Z", signedUp: 0, spotsLeft: null, signedUpList: [], lineup: null, strategy: null },
  ],
  counts: { yes: 0, no: 0, maybe: 0, pending: 2, bySession: { full: 0, first: 0, last: 0 } },
  members: [member("100000001"), member("100000002")],
});

describe("withEventAnswer", () => {
  it("moves a member from no answer into the selected event part immediately", () => {
    const updated = withEventAnswer(detail(), "100000001", {
      answer: "yes",
      sessionId: "full",
      answeredAt: "2026-09-23T00:00:00.000Z",
    });

    expect(updated.counts).toEqual({ yes: 1, no: 0, maybe: 0, pending: 1, bySession: { full: 1, first: 0, last: 0 } });
    expect(updated.members?.find((item) => item.playerId === "100000001")).toMatchObject({
      answer: "yes",
      sessionId: "full",
    });
  });

  it("moves the same member between parts or into can't without double-counting", () => {
    const joined = withEventAnswer(detail(), "100000001", {
      answer: "yes",
      sessionId: "full",
      answeredAt: "2026-09-23T00:00:00.000Z",
    });
    const switched = withEventAnswer(joined, "100000001", {
      answer: "yes",
      sessionId: "last",
      answeredAt: "2026-09-23T00:01:00.000Z",
    });
    const withdrawn = withEventAnswer(switched, "100000001", {
      answer: "no",
      answeredAt: "2026-09-23T00:02:00.000Z",
    });

    expect(switched.counts.bySession).toEqual({ full: 0, first: 0, last: 1 });
    expect(withdrawn.counts).toEqual({ yes: 0, no: 1, maybe: 0, pending: 1, bySession: { full: 0, first: 0, last: 0 } });
    expect(withdrawn.members?.[0]).toMatchObject({ answer: "no", sessionId: null });
  });
});
