import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventListItem } from "../api";
import { latestCompletedEvents, placementTrend, RecentPerformance } from "./RecentPerformance";

const event = (changes: Partial<EventListItem> = {}): EventListItem => ({
  eventId: "foundry-1",
  alliance: "POP",
  kind: "foundry",
  title: "Foundry — Legion 1",
  startsAt: "2026-09-20T19:00:00.000Z",
  deadlineAt: "2026-09-19T19:00:00.000Z",
  sessions: [],
  createdBy: "officer",
  closed: true,
  myAnswer: "yes",
  mySessionId: "L1",
  history: {
    results: [],
    phases: [],
    mine: {
      attendance: "attended",
      attendanceEvidence: "score",
      scores: [{ key: "session:L1", label: "Legion 1", points: 515_000, precision: { kind: "rounded", display: "515.0K", roundedTo: 100 }, place: 2, scoredPlayers: 31 }],
    },
  },
  ...changes,
});

describe("recent home performance", () => {
  it("keeps only the latest three completed events", () => {
    const items = [
      event({ eventId: "future", startsAt: "2026-10-01T00:00:00Z" }),
      event({ eventId: "one", startsAt: "2026-09-27T00:00:00Z" }),
      event({ eventId: "two", startsAt: "2026-09-26T00:00:00Z" }),
      event({ eventId: "three", startsAt: "2026-09-25T00:00:00Z" }),
      event({ eventId: "four", startsAt: "2026-09-24T00:00:00Z" }),
    ];
    expect(latestCompletedEvents(items, new Date("2026-09-28T00:00:00Z")).map((item) => item.eventId)).toEqual(["one", "two", "three"]);
  });

  it("shows attendance, rounded points and place without inventing exact precision", () => {
    const html = renderToStaticMarkup(<RecentPerformance events={[
      event(),
      event({ eventId: "koi-1", kind: "koi", title: "King of Icefield", startsAt: "2026-09-26T12:00:00Z", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "phase:battle", label: "Castle battle", points: 90_000_000, place: 5, scoredPlayers: 32 }] } } }),
    ]} onOpen={() => undefined} onAllHistory={() => undefined} />);
    expect(html).toContain("Your recent performance");
    expect(html).toContain("Placement trend");
    expect(html).toContain("Performance series");
    expect(html).toContain("King of Icefield · Castle battle");
    expect(html).toContain("Two recorded placements are needed");
    expect(html).toContain("Attended");
    expect(html).toContain("≈ 515.0K pts");
    expect(html).toContain("#2 of 31");
    expect(html).toContain("All event history");
  });

  it("normalizes placement by field size so unlike events remain comparable", () => {
    const points = placementTrend([
      event({ eventId: "first", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "score", label: "Score", points: 1, place: 5, scoredPlayers: 10 }] } } }),
      event({ eventId: "second", startsAt: "2026-09-27T00:00:00Z", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "score", label: "Score", points: 1, place: 5, scoredPlayers: 100 }] } } }),
    ]);
    expect(points.map((point) => point.place)).toEqual([5, 5]);
    expect(points[1]!.performance).toBeGreaterThan(points[0]!.performance);
  });

  it("compares only the selected event and phase series", () => {
    const points = placementTrend([
      event({ eventId: "foundry-l1", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "session:L1", label: "Legion 1", points: 1, place: 5, scoredPlayers: 20 }] } } }),
      event({ eventId: "foundry-l2", startsAt: "2026-09-27T00:00:00Z", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "session:L2", label: "Legion 2", points: 2, place: 3, scoredPlayers: 20 }] } } }),
      event({ eventId: "koi", kind: "koi", startsAt: "2026-09-28T00:00:00Z", history: { results: [], phases: [], mine: { attendance: "attended", attendanceEvidence: "score", scores: [{ key: "phase:castle_battle", label: "Castle battle", points: 3, place: 1, scoredPlayers: 20 }] } } }),
    ], 8, "foundry:session");
    expect(points.map((point) => point.eventId)).toEqual(["foundry-l1", "foundry-l2"]);
    expect(new Set(points.map((point) => point.seriesKey))).toEqual(new Set(["foundry:session"]));
  });

  it("visually marks confirmed misses without treating unknown evidence as absence", () => {
    const missed = event({
      eventId: "missed",
      history: { results: [], phases: [], mine: { attendance: "did_not_attend", attendanceEvidence: "record", scores: [] } },
    });
    const unknown = event({
      eventId: "unknown",
      history: { results: [], phases: [], mine: { attendance: "not_reviewed", attendanceEvidence: null, scores: [] } },
    });
    const html = renderToStaticMarkup(<RecentPerformance events={[missed, unknown]} onOpen={() => undefined} onAllHistory={() => undefined} />);
    expect(html.match(/recent-performance-card-missed/g)).toHaveLength(1);
    expect(html).toContain("Did not attend");
    expect(html).toContain("Not recorded");
  });
});
