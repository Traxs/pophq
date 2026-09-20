import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { countAnswers, deadlineFor, isClosed, parseAnswer, parseNewEvent, type EventAnswer } from "./events.js";

const now = new Date("2026-09-19T12:00:00Z");
const ctx = { eventId: "01J0000000000000000000000A", createdBy: "officer-1", now };
const inTwoDays = "2026-09-21T19:00:00Z";

describe("parseNewEvent", () => {
  it("closes Foundry answers three days before, at the end of that day", () => {
    const e = parseNewEvent({ kind: "foundry", title: "  Foundry Saturday  ", startsAt: "2026-09-27T19:00:00Z" }, ctx);
    expect(e.deadlineAt).toBe("2026-09-24T23:59:59.999Z");
    expect(e.title).toBe("Foundry Saturday");
  });

  it("uses the officer's day when they are not on UTC", () => {
    // Berlin is two hours ahead in September: their end of the 24th is 21:59:59.999Z.
    const e = parseNewEvent(
      { kind: "foundry", title: "Foundry Saturday", startsAt: "2026-09-27T19:00:00Z", timeZoneOffsetMinutes: 120 },
      ctx,
    );
    expect(e.deadlineAt).toBe("2026-09-24T21:59:59.999Z");
  });

  it("closes an hour before for types without a lead time, and honours an override", () => {
    expect(parseNewEvent({ kind: "bear", title: "Bear hunt", startsAt: "2026-09-27T19:00:00Z" }, ctx).deadlineAt).toBe(
      "2026-09-27T18:00:00.000Z",
    );
    expect(
      parseNewEvent(
        { kind: "bear", title: "Bear hunt", startsAt: "2026-09-27T19:00:00Z", answersCloseDaysBefore: 1 },
        ctx,
      ).deadlineAt,
    ).toBe("2026-09-26T23:59:59.999Z");
  });

  it("allows an event whose answers already closed, so it can be added late", () => {
    const e = parseNewEvent({ kind: "foundry", title: "Added late", startsAt: "2026-09-20T19:00:00Z" }, ctx);
    expect(e.deadlineAt).toBe("2026-09-17T23:59:59.999Z"); // before "now" (19 Sep): already closed
    expect(isClosed(e, now)).toBe(true);
  });

  it("normalises the input", () => {
    const e = parseNewEvent({ kind: "foundry", title: "  Foundry Saturday  ", startsAt: inTwoDays }, ctx);
    expect(e).toMatchObject({
      eventId: ctx.eventId,
      kind: "foundry",
      title: "Foundry Saturday",
      startsAt: "2026-09-21T19:00:00.000Z",
      alliance: "POP",
      createdBy: "officer-1",
    });
    expect(e.notes).toBeUndefined();
  });

  it("keeps an explicit deadline and the notes", () => {
    const e = parseNewEvent(
      { title: "Bear hunt", startsAt: inTwoDays, deadlineAt: "2026-09-20T12:00:00Z", notes: " bring traps " },
      ctx,
    );
    expect(e).toMatchObject({ kind: "other", deadlineAt: "2026-09-20T12:00:00.000Z", notes: "bring traps" });
  });

  it.each([
    ["a title that is too short", { title: "Hi", startsAt: inTwoDays }],
    ["a start in the past", { title: "Yesterday", startsAt: "2026-09-18T12:00:00Z" }],
    ["a start more than a year away", { title: "Typo year", startsAt: "2028-09-21T19:00:00Z" }],
    ["a deadline after the start", { title: "Late close", startsAt: inTwoDays, deadlineAt: "2026-09-22T19:00:00Z" }],
    ["an unknown kind", { kind: "party", title: "Unknown kind", startsAt: inTwoDays }],
    ["an unreadable date", { title: "Broken date", startsAt: "soon" }],
  ])("rejects %s", (_case, input) => {
    expect(() => parseNewEvent(input, ctx)).toThrow(ValidationError);
  });
});

describe("parseAnswer", () => {
  it.each([
    ["yes", "yes"],
    [" NO ", "no"],
    ["Maybe", "maybe"],
  ])("accepts %j", (input, expected) => {
    expect(parseAnswer(input)).toBe(expected);
  });
  it.each(["", "sure", "y", null, 1])("rejects %j", (input) => {
    expect(() => parseAnswer(input)).toThrow(ValidationError);
  });
});

describe("deadlineFor", () => {
  it("counts whole days back and lands on the end of that day", () => {
    expect(deadlineFor("2026-09-20T12:00:00Z", 3)).toBe("2026-09-17T23:59:59.999Z");
    expect(deadlineFor("2026-09-20T12:00:00Z", 0)).toBe("2026-09-20T11:00:00.000Z");
  });
});

describe("isClosed", () => {
  it("closes exactly at the deadline", () => {
    expect(isClosed({ deadlineAt: "2026-09-19T12:00:01Z" }, now)).toBe(false);
    expect(isClosed({ deadlineAt: "2026-09-19T12:00:00Z" }, now)).toBe(true);
  });
});

describe("countAnswers with legions", () => {
  const yes = (playerId: string, sessionId?: string): EventAnswer => ({
    eventId: "e",
    playerId,
    answer: "yes",
    ...(sessionId ? { sessionId } : {}),
    answeredAt: now.toISOString(),
    source: "player",
  });

  it("counts each legion separately, and every yes once overall", () => {
    const counts = countAnswers([yes("1", "L1"), yes("2", "L2"), yes("3", "L2")], 10);
    expect(counts).toEqual({ yes: 3, no: 0, maybe: 0, pending: 7, bySession: { L1: 1, L2: 2 } });
  });
});

describe("countAnswers", () => {
  const answer = (playerId: string, a: "yes" | "no" | "maybe"): EventAnswer => ({
    eventId: "e",
    playerId,
    answer: a,
    answeredAt: now.toISOString(),
    source: "player",
  });

  it("counts each answer and who is still missing", () => {
    const answers = [answer("1", "yes"), answer("2", "yes"), answer("3", "no"), answer("4", "maybe")];
    expect(countAnswers(answers, 10)).toEqual({ yes: 2, no: 1, maybe: 1, pending: 6, bySession: {} });
  });

  it("never reports a negative pending count", () => {
    expect(countAnswers([answer("1", "yes")], 0)).toEqual({ yes: 1, no: 0, maybe: 0, pending: 0, bySession: {} });
  });
});
