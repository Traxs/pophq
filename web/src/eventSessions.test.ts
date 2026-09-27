import { describe, expect, it } from "vitest";
import type { SessionView } from "./api";
import { visibleEventSessions } from "./eventSessions";

const session = (id: string, changes: Partial<SessionView> = {}): SessionView => ({
  id,
  label: id,
  startsAt: "2026-09-26T12:00:00.000Z",
  signedUp: 0,
  spotsLeft: null,
  signedUpList: [],
  lineup: null,
  strategy: null,
  result: null,
  ...changes,
});

const phaseScores = {
  preparation: {
    phaseKey: "preparation" as const,
    phaseLabel: "Preparation",
    version: 1,
    coverage: "partial" as const,
    scoredPlayers: 0,
    reportedPlayerSubtotal: 0,
    entries: [],
  },
  castle_battle: {
    phaseKey: "castle_battle" as const,
    phaseLabel: "Castle battle",
    version: 1,
    coverage: "partial" as const,
    scoredPlayers: 32,
    reportedPlayerSubtotal: 1_223_593_710,
    entries: [],
  },
};

describe("event session visibility", () => {
  it("keeps phase-event RSVP choices while the event is active", () => {
    const sessions = [session("Full time"), session("First half"), session("Last half")];
    expect(visibleEventSessions({ sessions, scoreboards: phaseScores }, false)).toEqual(sessions);
  });

  it("hides empty RSVP choices after a phase-scored event is complete", () => {
    const sessions = [session("Full time"), session("First half"), session("Last half")];
    expect(visibleEventSessions({ sessions, scoreboards: phaseScores }, true)).toEqual([]);
  });

  it("retains a genuine historical session record on a completed phase event", () => {
    const recorded = session("Full time", {
      strategy: { version: 1, body: "Castle plan", publishedAt: "2026-09-25T12:00:00.000Z", assignments: [] },
    });
    expect(visibleEventSessions({ sessions: [recorded, session("First half")], scoreboards: phaseScores }, true)).toEqual([recorded]);
  });

  it("keeps result-bearing sessions for events such as Foundry", () => {
    const sessions = [session("Legion 1"), session("Legion 2")];
    expect(visibleEventSessions({ sessions }, true)).toEqual(sessions);
  });
});
