import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import { eventSignupMessage, eventSignupUrl } from "./eventShare";

const event: EventListItem = {
  eventId: "foundry-1",
  alliance: "POP",
  kind: "foundry",
  title: "Foundry",
  startsAt: "2026-10-03T12:00:00.000Z",
  deadlineAt: "2026-10-01T21:59:59.999Z",
  sessions: [
    { id: "L1", label: "Legion 1", startsAt: "2026-10-03T19:00:00.000Z" },
    { id: "L2", label: "Legion 2", startsAt: "2026-10-03T12:00:00.000Z" },
  ],
  createdBy: "officer",
  closed: false,
  myAnswer: null,
  mySessionId: null,
};

describe("event signup sharing", () => {
  it("builds a protected direct event link", () => {
    expect(eventSignupUrl(event.eventId, "https://pophq.fyi")).toBe("https://pophq.fyi/events/foundry-1");
  });

  it("copies the two legion times, deadline and direct link in UTC", () => {
    const message = eventSignupMessage(event, "https://pophq.fyi");
    expect(message).toContain("Sign up for Foundry");
    expect(message).toContain("Legion 1: Sat 3 Oct, 19:00 UTC");
    expect(message).toContain("Legion 2: Sat 3 Oct, 12:00 UTC");
    expect(message).toContain("Answers close: Thu 1 Oct, 21:59 UTC");
    expect(message).toContain("https://pophq.fyi/events/foundry-1");
  });
});
