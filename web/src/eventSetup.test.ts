import { describe, expect, it } from "vitest";
import { defaultEventSessions, isLegionEvent } from "./eventSetup";

describe("event session setup", () => {
  it.each(["foundry", "canyon"] as const)("gives %s Legion 1 and Legion 2", (kind) => {
    expect(isLegionEvent(kind)).toBe(true);
    expect(defaultEventSessions(kind)).toEqual([
      { id: "L1", label: "Legion 1", startsAt: "" },
      { id: "L2", label: "Legion 2", startsAt: "" },
    ]);
  });

  it("keeps availability events and simple RSVP events distinct", () => {
    expect(defaultEventSessions("koi").map((session) => session.id)).toEqual(["full", "first", "last"]);
    expect(defaultEventSessions("tundra")).toEqual([]);
    expect(isLegionEvent("koi")).toBe(false);
  });
});
