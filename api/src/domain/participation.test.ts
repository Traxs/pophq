import { describe, expect, it } from "vitest";
import type { AttendanceRecord } from "./attendance.js";
import type { AllianceEvent, EventAnswer } from "./events.js";
import { classify, participationOf } from "./participation.js";

const now = new Date("2026-09-22T12:00:00Z");

const event = (n: number, daysAgo: number): AllianceEvent => ({
  eventId: `E${n}`,
  alliance: "POP",
  kind: "foundry",
  title: `Foundry ${n}`,
  startsAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  deadlineAt: new Date(now.getTime() - (daysAgo + 3) * 24 * 60 * 60 * 1000).toISOString(),
  sessions: [],
  createdBy: "officer",
});

const yes = (eventId: string): EventAnswer => ({
  eventId,
  playerId: "100000001",
  answer: "yes",
  answeredAt: "2026-09-01T00:00:00Z",
  source: "player",
});

const attended = (eventId: string, status: AttendanceRecord["status"]): AttendanceRecord => ({
  eventId,
  playerId: "100000001",
  status,
  source: "officer",
  recordedAt: "2026-09-02T00:00:00Z",
});

describe("classify", () => {
  it("separates the three things that actually happen", () => {
    expect(classify(yes("E1"), attended("E1", "present"))).toBe("attended");
    expect(classify(yes("E1"), attended("E1", "absent"))).toBe("no_show");
    expect(classify(undefined, undefined)).toBe("unregistered");
  });

  it("treats absent-without-signing-up as disengagement, not a broken promise", () => {
    expect(classify(undefined, attended("E1", "absent"))).toBe("unregistered");
  });

  it("never counts a missing attendance record against someone who engaged", () => {
    expect(classify(yes("E1"), undefined)).toBe("not_counted");
    const cant: EventAnswer = { ...yes("E1"), answer: "no" };
    // Saying "I can't make it" is engagement; it is not a no-show and not disengagement.
    expect(classify(cant, undefined)).toBe("not_counted");
    expect(classify(cant, attended("E1", "absent"))).toBe("unregistered");
  });

  it("leaves an excused absence out of it entirely", () => {
    expect(classify(yes("E1"), attended("E1", "excused"))).toBe("excused");
    expect(classify(undefined, attended("E1", "unknown"))).toBe("unregistered");
  });
});

describe("participationOf", () => {
  const events = [event(1, 1), event(2, 5), event(3, 9), event(4, 13)];

  it("gives a full rate to somebody who turns up to everything", () => {
    const result = participationOf({
      events,
      answers: events.map((e) => yes(e.eventId)),
      attendance: events.map((e) => attended(e.eventId, "present")),
      now,
    });
    expect(result.rate).toBe(1);
    expect(result).toMatchObject({ attended: 4, noShows: 0, unregistered: 0, sample: 4 });
  });

  it("makes a no-show cost twice what an attendance earns", () => {
    const result = participationOf({
      events,
      answers: events.map((e) => yes(e.eventId)),
      attendance: [
        attended("E1", "present"),
        attended("E2", "present"),
        attended("E3", "present"),
        attended("E4", "absent"),
      ],
      now,
    });
    // Three attended against one no-show at double weight: 3 / (3 + 2).
    expect(result.rate).toBeCloseTo(0.6);
    expect(result.noShows).toBe(1);
  });

  it("makes never answering cost half, so quiet disengagement still shows", () => {
    const result = participationOf({
      events,
      answers: [yes("E1"), yes("E2")],
      attendance: [attended("E1", "present"), attended("E2", "present")],
      now,
    });
    // Two attended, two never answered: 2 / (2 + 1).
    expect(result.rate).toBeCloseTo(2 / 3);
    expect(result).toMatchObject({ attended: 2, unregistered: 2 });
  });

  it("scores somebody who answers nothing at all as zero, not as unknown", () => {
    const result = participationOf({ events, answers: [], attendance: [], now });
    expect(result.rate).toBe(0);
    expect(result.unregistered).toBe(4);
  });

  it("leaves excused absences out of the sum", () => {
    const result = participationOf({
      events: [event(1, 1), event(2, 5)],
      answers: [yes("E1"), yes("E2")],
      attendance: [attended("E1", "present"), attended("E2", "excused")],
      now,
    });
    expect(result.rate).toBe(1);
    expect(result).toMatchObject({ excused: 1, sample: 1 });
  });

  it("has no rate at all when nothing counted, which is not the same as zero", () => {
    const result = participationOf({
      events: [event(1, 1)],
      answers: [yes("E1")],
      attendance: [],
      now,
    });
    expect(result.rate).toBeUndefined();
    expect(result.sample).toBe(0);
  });

  it("treats legacy Foundry L1 and L2 events on the same day as one choice", () => {
    const l1 = {
      ...event(11, 2),
      eventId: "F-L1",
      title: "Foundry — Legion 1",
      startsAt: "2026-09-20T12:00:00.000Z",
    };
    const l2 = {
      ...event(12, 2),
      eventId: "F-L2",
      title: "Foundry — Legion 2",
      startsAt: "2026-09-20T19:00:00.000Z",
    };
    const result = participationOf({ events: [l1, l2], answers: [yes("F-L2")], attendance: [], now });

    expect(result.events).toEqual([
      expect.objectContaining({ eventId: "F-L2", title: "Foundry — Legion 2", outcome: "not_counted" }),
    ]);
    expect(result.rate).toBeUndefined();
    expect(result).toMatchObject({ attended: 0, unregistered: 0, sample: 0 });
  });

  it("credits attendance in the chosen legacy Foundry legion without counting its sibling", () => {
    const l1 = {
      ...event(11, 2),
      eventId: "F-L1",
      title: "Foundry — Legion 1",
      startsAt: "2026-09-20T12:00:00.000Z",
    };
    const l2 = {
      ...event(12, 2),
      eventId: "F-L2",
      title: "Foundry — Legion 2",
      startsAt: "2026-09-20T19:00:00.000Z",
    };
    const result = participationOf({
      events: [l1, l2],
      answers: [yes("F-L2")],
      attendance: [attended("F-L2", "present")],
      now,
    });

    expect(result.rate).toBe(1);
    expect(result).toMatchObject({ attended: 1, unregistered: 0, sample: 1 });
    expect(result.events).toHaveLength(1);
  });

  it("accepts a positive confirmed player score as attendance evidence", () => {
    const result = participationOf({
      events: [event(1, 1)],
      answers: [],
      attendance: [],
      scoreEvidence: ["E1"],
      now,
    });

    expect(result.rate).toBe(1);
    expect(result).toMatchObject({ attended: 1, unregistered: 0, sample: 1 });
  });

  it("uses score evidence in either legacy Foundry legion only once", () => {
    const l1 = { ...event(11, 2), eventId: "F-L1", startsAt: "2026-09-20T12:00:00.000Z" };
    const l2 = { ...event(12, 2), eventId: "F-L2", startsAt: "2026-09-20T19:00:00.000Z" };
    const result = participationOf({
      events: [l1, l2],
      answers: [],
      attendance: [],
      scoreEvidence: ["F-L2"],
      now,
    });

    expect(result.rate).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventId: "F-L2", outcome: "attended" });
  });

  it("counts a completely unanswered legacy Foundry only once", () => {
    const l1 = { ...event(11, 2), eventId: "F-L1", startsAt: "2026-09-20T12:00:00.000Z" };
    const l2 = { ...event(12, 2), eventId: "F-L2", startsAt: "2026-09-20T19:00:00.000Z" };
    const result = participationOf({ events: [l1, l2], answers: [], attendance: [], now });

    expect(result.rate).toBe(0);
    expect(result).toMatchObject({ unregistered: 1, sample: 1 });
    expect(result.events).toHaveLength(1);
  });

  it("ignores events that have not happened yet", () => {
    const upcoming = { ...event(9, -5), eventId: "E9" };
    const result = participationOf({ events: [...events, upcoming], answers: [], attendance: [], now });
    expect(result.events.some((e) => e.eventId === "E9")).toBe(false);
  });

  it("does not blame an imported account for staying silent before it existed", () => {
    const knownSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = participationOf({ events, answers: [], attendance: [], now, knownSince });
    // Only the two events since the account appeared count.
    expect(result.unregistered).toBe(2);
    expect(result.events.map((e) => e.eventId)).toEqual(["E1", "E2"]);
  });

  it("still counts imported evidence from before the account was known", () => {
    const knownSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // The Foundry import brought attendance for a battle predating the account row it created.
    const result = participationOf({
      events,
      answers: [],
      attendance: [attended("E4", "present")],
      now,
      knownSince,
    });
    expect(result.attended).toBe(1);
    expect(result.events.map((e) => e.eventId)).toContain("E4");
  });

  it("weighs only the most recent events, newest first", () => {
    const many = Array.from({ length: 15 }, (_, i) => event(i + 1, i + 1));
    const result = participationOf({ events: many, answers: [], attendance: [], now, window: 10 });
    expect(result.events).toHaveLength(10);
    expect(result.events[0]!.eventId).toBe("E1");
    expect(result.events.at(-1)!.eventId).toBe("E10");
  });
});
