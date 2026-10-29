import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventListItem } from "../api";
import { ActiveEventRail, HomeRegistrationPrompt, activeRegistrationEvents, activeRegistrationTime, unansweredRegistrationEvents } from "./ActiveEventRegistration";

const event = (changes: Partial<EventListItem> = {}): EventListItem => ({
  eventId: "foundry",
  alliance: "POP",
  kind: "foundry",
  title: "Foundry",
  startsAt: "2026-10-04T12:00:00.000Z",
  deadlineAt: "2026-10-03T12:00:00.000Z",
  sessions: [],
  createdBy: "officer",
  closed: false,
  myAnswer: null,
  mySessionId: null,
  ...changes,
});

describe("active event registration summaries", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");

  it("includes only upcoming open events and sorts the nearest first", () => {
    const items = [
      event({ eventId: "canyon", kind: "canyon", startsAt: "2026-10-05T12:00:00Z" }),
      event({ eventId: "closed", closed: true }),
      event({ eventId: "past", startsAt: "2026-09-20T12:00:00Z" }),
      event(),
    ];
    expect(activeRegistrationEvents(items, now).map((item) => item.eventId)).toEqual(["foundry", "canyon"]);
  });

  it("counts only events the acting account has not answered", () => {
    const items = [event(), event({ eventId: "canyon", kind: "canyon" }), event({ eventId: "answered", myAnswer: "yes" })];
    expect(unansweredRegistrationEvents(items, now).map((item) => item.eventId)).toEqual(["foundry", "canyon"]);
  });

  it("makes the Home action and Events rail explicit", () => {
    const items = [event(), event({ eventId: "canyon", kind: "canyon", title: "Canyon" })];
    const home = renderToStaticMarkup(<HomeRegistrationPrompt events={items} now={now} onOpen={() => undefined} />);
    const rail = renderToStaticMarkup(<ActiveEventRail events={items} now={now} onOpen={() => undefined} />);
    expect(home).toContain("Register for 2 active events");
    expect(home).toContain("Foundry and Canyon need your response");
    expect(rail).toContain("2 events need your response");
    expect(rail.match(/Respond/g)).toHaveLength(2);
  });

  it("shows the answered legion and its actual time instead of the event default", () => {
    const answered = event({
      startsAt: "2026-11-01T12:00:00.000Z",
      myAnswer: "yes",
      mySessionId: "L1",
      sessions: [
        { id: "L1", label: "Legion 1", startsAt: "2026-11-01T19:00:00.000Z" },
        { id: "L2", label: "Legion 2", startsAt: "2026-11-01T12:00:00.000Z" },
      ],
    });
    expect(activeRegistrationTime(answered)).toEqual({ label: "Legion 1", startsAt: "2026-11-01T19:00:00.000Z" });
    const rail = renderToStaticMarkup(<ActiveEventRail events={[answered]} now={now} onOpen={() => undefined} />);
    expect(rail).toContain("Legion 1 · Sun 1 Nov, 19:00 UTC");
    expect(rail).not.toContain("Sun 1 Nov, 12:00 UTC");
  });

  it("hides the Home prompt once everything is answered", () => {
    const html = renderToStaticMarkup(<HomeRegistrationPrompt events={[event({ myAnswer: "no" })]} now={now} onOpen={() => undefined} />);
    expect(html).toBe("");
  });
});
