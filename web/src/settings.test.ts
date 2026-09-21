import { describe, expect, it } from "vitest";
import { BOTS_SECTION, canManageBots, sectionsFor } from "./settings";

describe("settings sections", () => {
  it("shows bot access to officers and owners only", () => {
    expect(canManageBots(["officer"])).toBe(true);
    expect(canManageBots(["owner"])).toBe(true);
    expect(canManageBots(["player"])).toBe(false);
    expect(canManageBots([])).toBe(false);
  });

  it("always offers the account section, and adds bots for an officer", () => {
    expect(sectionsFor([]).map((s) => s.id)).toEqual(["accounts"]);
    expect(sectionsFor(["officer"]).map((s) => s.id)).toEqual(["accounts", "bots"]);
    expect(sectionsFor(["owner", "player"])).toContain(BOTS_SECTION);
  });
});
