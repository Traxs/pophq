import { describe, expect, it } from "vitest";
import { leadDaysOf } from "./eventTiming";

describe("leadDaysOf", () => {
  it("recognises a Foundry closing three days before", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-17T23:59:59.999Z" })).toBe(3);
  });
  it("recognises the one-hour case", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-20T11:00:00.000Z" })).toBe(0);
  });
  it("rounds a partial day to the nearest whole day", () => {
    expect(leadDaysOf({ startsAt: "2026-09-20T12:00:00Z", deadlineAt: "2026-09-19T23:59:59.999Z" })).toBe(1);
  });
});
