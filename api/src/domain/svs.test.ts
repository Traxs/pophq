import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import {
  buffScore,
  dayEndsAt,
  defaultDays,
  defaultDeadline,
  parseNewRound,
  parsePreferences,
  rankCandidates,
  roundState,
  slotStartsAt,
  type SvsRound,
} from "./svs.js";

const now = new Date("2026-09-21T12:00:00Z");
const ctx = { roundId: "R1", createdBy: "officer-1", now };

describe("parseNewRound", () => {
  it("builds the usual week from its Monday: Construction, Research, Training", () => {
    const round = parseNewRound({ label: "SvS week 41", weekStart: "2026-10-05" }, ctx);
    expect(round.days).toEqual([
      { id: "construction", buff: "construction", date: "2026-10-05" }, // Monday
      { id: "research", buff: "research", date: "2026-10-06" }, // Tuesday
      { id: "training", buff: "training", date: "2026-10-08" }, // Thursday
    ]);
    // Without an explicit deadline, preferences close as the first buff day begins.
    expect(round.preferenceDeadline).toBe("2026-10-04T23:59:59.999Z");
    expect(round.alliance).toBe("POP");
  });

  it("takes spelled-out days for a week that breaks the pattern", () => {
    const round = parseNewRound(
      {
        label: "Odd week",
        days: [
          { buff: "construction", date: "2026-10-06" },
          { buff: "training", date: "2026-10-09" },
        ],
      },
      ctx,
    );
    expect(round.days.map((d) => `${d.id} ${d.date}`)).toEqual(["construction 2026-10-06", "training 2026-10-09"]);
  });

  it("gives repeated buffs their own ids", () => {
    const round = parseNewRound(
      {
        label: "Two training days",
        days: [
          { buff: "training", date: "2026-10-06" },
          { buff: "training", date: "2026-10-09" },
        ],
      },
      ctx,
    );
    expect(round.days.map((d) => d.id)).toEqual(["training-1", "training-2"]);
  });

  it("refuses a deadline after the buffs start, and a round already over", () => {
    expect(() =>
      parseNewRound({ label: "Too late", weekStart: "2026-10-05", preferenceDeadline: "2026-10-06T00:00:00Z" }, ctx),
    ).toThrow(/must close before the first buff day/);
    expect(() => parseNewRound({ label: "Last month", weekStart: "2026-08-03" }, ctx)).toThrow(/already over/);
  });

  it("needs either a week or explicit days, and a name", () => {
    expect(() => parseNewRound({ label: "Nothing" }, ctx)).toThrow(ValidationError);
    expect(() => parseNewRound({ weekStart: "2026-10-05" }, ctx)).toThrow(ValidationError);
  });
});

describe("slots", () => {
  it("cuts a day into 48 half-hour slots from midnight UTC", () => {
    const day = { date: "2026-10-05" };
    expect(slotStartsAt(day, 0)).toBe("2026-10-05T00:00:00.000Z");
    expect(slotStartsAt(day, 1)).toBe("2026-10-05T00:30:00.000Z");
    expect(slotStartsAt(day, 47)).toBe("2026-10-05T23:30:00.000Z");
    expect(dayEndsAt(day)).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("roundState", () => {
  const round = (over: Partial<SvsRound> = {}): Pick<SvsRound, "days" | "preferenceDeadline" | "publishedAt"> => ({
    days: defaultDays("2026-10-05"),
    preferenceDeadline: defaultDeadline(defaultDays("2026-10-05")),
    ...over,
  });

  it("collects until the deadline, then plans, then publishes, then closes", () => {
    expect(roundState(round(), new Date("2026-10-01T00:00:00Z"))).toBe("collecting");
    expect(roundState(round(), new Date("2026-10-04T23:59:59.999Z"))).toBe("planning");
    expect(roundState(round({ publishedAt: "2026-10-05T06:00:00Z" }), new Date("2026-10-05T07:00:00Z"))).toBe("published");
    // Closed once the last buff day is over, published or not.
    expect(roundState(round({ publishedAt: "2026-10-05T06:00:00Z" }), new Date("2026-10-09T00:00:00Z"))).toBe("closed");
    expect(roundState(round(), new Date("2026-10-09T00:00:00Z"))).toBe("closed");
  });
});

describe("parsePreferences", () => {
  const round = { roundId: "R1", days: defaultDays("2026-10-05") };
  const at = { playerId: "100000001", now };

  it("keeps up to three ranked times per day, best first", () => {
    const prefs = parsePreferences(round, { days: [{ dayId: "construction", slots: [40, 41, 20] }] }, at);
    expect(prefs.days[0]).toMatchObject({ dayId: "construction", slots: [40, 41, 20], anyTime: false, unavailable: false });
    expect(prefs.updatedAt).toBe(now.toISOString());
  });

  it("accepts \"any time\" and \"not this day\", which are different answers", () => {
    const prefs = parsePreferences(
      round,
      { days: [{ dayId: "research", anyTime: true }, { dayId: "training", unavailable: true, note: "night shift" }] },
      at,
    );
    expect(prefs.days[0]).toMatchObject({ anyTime: true, slots: [] });
    expect(prefs.days[1]).toMatchObject({ unavailable: true, note: "night shift" });
  });

  it("refuses contradictions and unknown days", () => {
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", anyTime: true, unavailable: true }] }, at)).toThrow(ValidationError);
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", unavailable: true, slots: [3] }] }, at)).toThrow(ValidationError);
    expect(() => parsePreferences(round, { days: [{ dayId: "harvest", slots: [1] }] }, at)).toThrow(/no buff day/);
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", slots: [1] }, { dayId: "construction", slots: [2] }] }, at)).toThrow(/One answer per buff day/);
  });

  it("refuses more than three times, a repeated time, or a slot outside the day", () => {
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", slots: [1, 2, 3, 4] }] }, at)).toThrow(ValidationError);
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", slots: [5, 5] }] }, at)).toThrow(/picked twice/);
    expect(() => parsePreferences(round, { days: [{ dayId: "construction", slots: [48] }] }, at)).toThrow(ValidationError);
  });
});

describe("buffScore", () => {
  it("weighs attendance 60, strength 20 and kudos 20", () => {
    expect(buffScore({ attendanceRate: 1, strength: 100, strongest: 100, kudosShare: 1 })).toBeCloseTo(1);
    expect(buffScore({ attendanceRate: 0, strength: 0, strongest: 100, kudosShare: 0 })).toBe(0);
    expect(buffScore({ attendanceRate: 1, strength: 0, strongest: 100, kudosShare: 0 })).toBeCloseTo(0.6);
    expect(buffScore({ attendanceRate: 0, strength: 100, strongest: 100, kudosShare: 0 })).toBeCloseTo(0.2);
  });

  it("counts unknown attendance as reliable, like the Foundry lineup", () => {
    expect(buffScore({ strength: 50, strongest: 100, kudosShare: 0 })).toBeCloseTo(0.7);
  });

  it("never lets one account score above full strength", () => {
    expect(buffScore({ attendanceRate: 1, strength: 500, strongest: 100, kudosShare: 1 })).toBeCloseTo(1);
  });
});

describe("rankCandidates", () => {
  it("honours what people asked for before it consults the score", () => {
    const ranked = rankCandidates(
      [
        { playerId: "100000001", attendanceRate: 1, strength: 100, rank: 2 },
        { playerId: "100000002", attendanceRate: 0.2, strength: 10, rank: 1 },
        { playerId: "100000003", attendanceRate: 1, strength: 100 }, // "any time"
      ],
      100,
    );
    expect(ranked.map((c) => c.playerId)).toEqual(["100000002", "100000001", "100000003"]);
    expect(ranked[0]!.position).toBe(1);
  });

  it("falls back to the score, then the id, when the wish rank is the same", () => {
    const ranked = rankCandidates(
      [
        { playerId: "100000002", attendanceRate: 0.5, strength: 10, rank: 1 },
        { playerId: "100000001", attendanceRate: 1, strength: 10, rank: 1 },
      ],
      100,
    );
    expect(ranked.map((c) => c.playerId)).toEqual(["100000001", "100000002"]);
  });
});
