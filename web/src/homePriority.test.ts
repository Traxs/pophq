import { describe, expect, it } from "vitest";
import type { EventListItem, OfficerJob, SvsRoundListItem } from "./api";
import { homePriorities } from "./homePriority";

const now = new Date("2026-09-29T12:00:00.000Z");
const event = (changes: Partial<EventListItem> = {}): EventListItem => ({
  eventId: "foundry", alliance: "POP", kind: "foundry", title: "Foundry", startsAt: "2026-10-01T12:00:00.000Z", deadlineAt: "2026-09-30T12:00:00.000Z", sessions: [], createdBy: "r4", closed: false, myAnswer: null, mySessionId: null, ...changes,
});
const base = { events: [] as EventListItem[], round: null, powerLoaded: true, latestPowerAt: "2026-09-20T12:00:00.000Z", officerJobs: [] as OfficerJob[], now };

describe("Home priority engine", () => {
  it("puts overdue officer work before a registration closing within 24 hours", () => {
    const items = homePriorities({ ...base, events: [event({ deadlineAt: "2026-09-30T11:00:00.000Z" })], officerJobs: [{ eventId: "old", eventTitle: "KOI", startsAt: "2026-09-28T12:00:00Z", ownerPlayerId: null, ownerName: null, mine: false, taskId: "attendance", label: "Record who turned up", dueAt: "2026-09-29T10:00:00Z" }] });
    expect(items.map((item) => item.kind)).toEqual(["officer", "event-response"]);
    expect(items.map((item) => item.tier)).toEqual([0, 1]);
  });

  it("keeps a distant booked Ministry appointment in upcoming instead of attention", () => {
    const round = { roundId: "term", label: "Ministries", alliance: "POP", preferenceDeadline: "2026-09-30T00:00:00Z", state: "planning", answered: true, days: [], nextBooking: { bookingId: "book", roundId: "term", dayId: "construction", slot: 30, kind: "member", playerId: "1", playerName: "Traxes", alliance: "POP", createdAt: now.toISOString(), startsAt: "2026-10-05T15:00:00Z", buff: "construction" } } satisfies SvsRoundListItem;
    const items = homePriorities({ ...base, round });
    expect(items).toEqual([expect.objectContaining({ kind: "ministry-appointment", section: "upcoming", tier: 5 })]);
  });

  it("promotes an imminent Ministry appointment and an overdue power report", () => {
    const round = { roundId: "term", label: "Ministries", alliance: "POP", preferenceDeadline: "2026-09-30T00:00:00Z", state: "planning", answered: true, days: [], nextBooking: { bookingId: "book", roundId: "term", dayId: "research", slot: 26, kind: "member", playerId: "1", playerName: "Traxes", alliance: "POP", createdAt: now.toISOString(), startsAt: "2026-09-29T13:00:00Z", buff: "research" } } satisfies SvsRoundListItem;
    const items = homePriorities({ ...base, round, latestPowerAt: "2026-08-20T12:00:00Z" });
    expect(items.map((item) => [item.kind, item.tier])).toEqual([["power", 1], ["ministry-appointment", 2]]);
    expect(items[1]?.section).toBe("attention");
  });

  it("does not create completed-action noise when everything is current", () => {
    expect(homePriorities(base)).toEqual([]);
  });
});
