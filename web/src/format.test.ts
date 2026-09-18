import { describe, expect, it } from "vitest";
import { change, compact, formatDigitsInput, initials, parseDigits, relativeDay } from "./format";

describe("number input", () => {
  it("formats while typing and strips everything but digits", () => {
    expect(formatDigitsInput("45000000")).toBe("45,000,000");
    expect(formatDigitsInput("45.000.000")).toBe("45,000,000");
    expect(formatDigitsInput("0045")).toBe("45");
    expect(formatDigitsInput("abc")).toBe("");
  });

  it("parses formatted values back", () => {
    expect(parseDigits("45,000,000")).toBe(45_000_000);
    expect(parseDigits("")).toBeUndefined();
  });

  it("formats compact numbers", () => {
    expect(compact(45_123_456)).toBe("45.1M");
    expect(compact(950)).toBe("950");
  });
});

describe("change", () => {
  it("computes direction and percent", () => {
    expect(change(110, 100)).toEqual({ absolute: 10, percent: 10, direction: "up" });
    expect(change(90, 100)?.direction).toBe("down");
    expect(change(100, 100)?.direction).toBe("flat");
  });

  it("has no change without a usable baseline", () => {
    expect(change(100, undefined)).toBeUndefined();
    expect(change(100, 0)).toBeUndefined();
  });
});

describe("relativeDay", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  it.each([
    ["2026-09-18T08:00:00Z", "today"],
    ["2026-09-17T08:00:00Z", "yesterday"],
    ["2026-09-13T12:00:00Z", "5 days ago"],
    ["2026-08-28T12:00:00Z", "3 weeks ago"],
    ["2026-07-01T12:00:00Z", "2 months ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(relativeDay(iso, now)).toBe(expected);
  });
});

describe("initials", () => {
  it("prefers capital letters, else the first two characters", () => {
    expect(initials("IceQueen")).toBe("IQ");
    expect(initials("poppy")).toBe("PO");
    expect(initials("Goatzilla")).toBe("GO");
  });
});
