import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { KUDOS_HALF_LIFE_DAYS, kudosScore, kudosShare, parseKudos } from "./kudos.js";

const now = new Date("2026-09-21T12:00:00Z");
const ctx = { awardId: "K1", playerId: "100000001", awardedBy: "officer-1", now };
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

describe("parseKudos", () => {
  it("records points with a reason and stamps the time", () => {
    const award = parseKudos({ points: 5, reason: "  Covered a night slot  " }, ctx);
    expect(award).toMatchObject({ awardId: "K1", playerId: "100000001", points: 5, reason: "Covered a night slot", awardedBy: "officer-1" });
    expect(award.awardedAt).toBe(now.toISOString());
  });

  it("allows negative points, which is how an officer takes some back", () => {
    expect(parseKudos({ points: -3, reason: "Awarded twice by mistake" }, ctx).points).toBe(-3);
  });

  it("refuses zero, silence, and more than fifty at once", () => {
    expect(() => parseKudos({ points: 0, reason: "Nothing" }, ctx)).toThrow(ValidationError);
    expect(() => parseKudos({ points: 5 }, ctx)).toThrow(ValidationError);
    expect(() => parseKudos({ points: 5, reason: "hi" }, ctx)).toThrow(ValidationError);
    expect(() => parseKudos({ points: 51, reason: "Too generous" }, ctx)).toThrow(ValidationError);
    expect(() => parseKudos({ points: 2.5, reason: "Half a point" }, ctx)).toThrow(ValidationError);
  });
});

describe("kudosScore", () => {
  it("counts today's award at face value", () => {
    expect(kudosScore([{ points: 10, awardedAt: now.toISOString() }], now)).toBeCloseTo(10);
  });

  it("halves after the half-life, and again after two", () => {
    expect(kudosScore([{ points: 10, awardedAt: daysAgo(KUDOS_HALF_LIFE_DAYS) }], now)).toBeCloseTo(5);
    expect(kudosScore([{ points: 10, awardedAt: daysAgo(KUDOS_HALF_LIFE_DAYS * 2) }], now)).toBeCloseTo(2.5);
  });

  it("decays a withdrawal too, so an old correction cannot wipe out recent work", () => {
    const score = kudosScore(
      [
        { points: 10, awardedAt: now.toISOString() },
        { points: -10, awardedAt: daysAgo(KUDOS_HALF_LIFE_DAYS * 2) },
      ],
      now,
    );
    expect(score).toBeCloseTo(7.5);
  });

  it("never lets a future date count for more than face value", () => {
    const ahead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(kudosScore([{ points: 10, awardedAt: ahead }], now)).toBeCloseTo(10);
  });

  it("is zero without awards", () => {
    expect(kudosScore([], now)).toBe(0);
  });
});

describe("kudosShare", () => {
  it("is the share of the best score in the alliance", () => {
    expect(kudosShare(5, 10)).toBe(0.5);
    expect(kudosShare(10, 10)).toBe(1);
  });

  it("is zero when nobody has kudos, or when someone is in the red", () => {
    expect(kudosShare(0, 0)).toBe(0);
    expect(kudosShare(-4, 10)).toBe(0);
  });
});
