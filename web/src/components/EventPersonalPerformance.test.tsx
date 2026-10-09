import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventListItem } from "../api";
import { EventPersonalPerformance } from "./EventPersonalPerformance";

const event = (eventId: string, startsAt: string, place: number): EventListItem => ({
  eventId,
  alliance: "POP",
  kind: "foundry",
  title: "Foundry",
  startsAt,
  deadlineAt: startsAt,
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
      scores: [{ key: "session:L1", label: "Legion 1", points: place * 1_000, place, scoredPlayers: 20 }],
    },
  },
});

describe("completed event personal performance", () => {
  it("shows rank, field size and a comparable previous result", () => {
    const previous = event("old", "2026-09-06T12:00:00Z", 8);
    const current = event("new", "2026-09-20T12:00:00Z", 3);
    const html = renderToStaticMarkup(<EventPersonalPerformance
      performance={current.history!.mine}
      event={current}
      history={[previous, current]}
    />);

    expect(html).toContain("Your performance");
    expect(html).toContain("#3 of 20");
    expect(html).toContain("Previous #8 of 20");
    expect(html).toContain("percentile pts");
    expect(html).toContain("recorded result confirms your attendance");
  });
});
