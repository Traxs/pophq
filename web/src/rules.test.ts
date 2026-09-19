import { describe, expect, it } from "vitest";
import { isReportOverdue, isValidEmail, isValidGameName, isValidLevel, isValidPlayerId, roleLabel } from "./rules";

describe("isReportOverdue", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  it("treats never reported as overdue", () => {
    expect(isReportOverdue(null, now)).toBe(true);
    expect(isReportOverdue(undefined, now)).toBe(true);
  });
  it("is overdue from 30 days on", () => {
    expect(isReportOverdue("2026-08-21T12:00:00Z", now)).toBe(false); // 29 days
    expect(isReportOverdue("2026-08-20T12:00:00Z", now)).toBe(true); // 30 days
  });
});

describe("isValidLevel", () => {
  // Same cases as the API's level validation (api/src/domain/measurements.test.ts).
  it.each(["1", "9", "25", "30", "FC1", "FC10", "FC5-2", "fc5-4", " FC3 "])("accepts %j", (v) => {
    expect(isValidLevel(v)).toBe(true);
  });
  it.each(["", "0", "31", "FC", "FC0", "FC11", "FC99", "FC5-5", "FC5-0", "5-2", "abc"])("rejects %j", (v) => {
    expect(isValidLevel(v)).toBe(false);
  });
});

describe("roleLabel", () => {
  it("shows the app role with the game rank", () => {
    expect(roleLabel(["player", "owner"], "R4", "POP")).toBe("Site owner · R4");
    expect(roleLabel(["player", "officer"], "R5", "POP")).toBe("Officer · R5");
    expect(roleLabel(["player", "officer", "owner"], "R3", "POP")).toBe("Site owner · R3");
  });
  it("falls back to rank, then alliance, for players", () => {
    expect(roleLabel(["player"], "R2", "POP")).toBe("R2");
    expect(roleLabel(["player"], undefined, "POP")).toBe("POP");
    expect(roleLabel(["owner"], undefined, "POP")).toBe("Site owner");
  });
});

describe("invite field checks", () => {
  it.each(["100000001", "410691488", "12345"])("accepts Player ID %j", (v) => {
    expect(isValidPlayerId(v)).toBe(true);
  });
  it.each(["", "1234", "0123456", "12a45", "1".repeat(16)])("rejects Player ID %j", (v) => {
    expect(isValidPlayerId(v)).toBe(false);
  });
  it.each(["a@b.co", "first.last@example.com"])("accepts email %j", (v) => {
    expect(isValidEmail(v)).toBe(true);
  });
  it.each(["", "no-at", "a@b", "a b@c.de"])("rejects email %j", (v) => {
    expect(isValidEmail(v)).toBe(false);
  });
  it("requires a game name of 2 to 30 characters", () => {
    expect(isValidGameName("Po")).toBe(true);
    expect(isValidGameName("P")).toBe(false);
    expect(isValidGameName("x".repeat(31))).toBe(false);
  });
});
