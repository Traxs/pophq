import { describe, expect, it } from "vitest";
import type { InviteResult } from "./api";
import { summarise } from "./invites";

const base: InviteResult = {
  account: { playerId: "100000001", name: "Frostbite", alliance: "POP", status: "active" },
  accountCreated: false,
  loginCreated: false,
  linked: false,
  seats: { used: 1, cap: 100 },
};

describe("summarise", () => {
  it("says what the invite actually changed", () => {
    expect(summarise({ ...base, accountCreated: true, loginCreated: true, linked: true })).toBe("Frostbite can sign in now");
    expect(summarise({ ...base, linked: true })).toBe("Frostbite linked to an existing login");
    expect(summarise({ ...base, accountCreated: true })).toBe("Frostbite added without a login");
    expect(summarise(base)).toBe("Frostbite was already set up");
  });
});
