import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { parseEventType, slugify, STARTER_TYPES } from "./eventTypes.js";

describe("slugify", () => {
  it.each([
    ["Foundry", "foundry"],
    ["Canyon Clash", "canyon-clash"],
    ["  Bear   Hunt!  ", "bear-hunt"],
    ["Fortress Ⅳ", "fortress-iv"],
  ])("%j -> %j", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });
  it("refuses a name with nothing to slug", () => {
    expect(() => slugify("!!!")).toThrow(ValidationError);
  });
});

describe("parseEventType", () => {
  it("fills in the id and part ids", () => {
    const type = parseEventType(
      { name: "Canyon Clash", leadDays: 2, sessions: [{ label: "Wave 1" }, { label: "Wave 2", defaultMinutes: 1140 }] },
      "officer-1",
    );
    expect(type).toMatchObject({
      typeId: "canyon-clash",
      name: "Canyon Clash",
      leadDays: 2,
      archived: false,
      createdBy: "officer-1",
      sessions: [
        { id: "S1", label: "Wave 1" },
        { id: "S2", label: "Wave 2", defaultMinutes: 1140 },
      ],
    });
  });

  it("keeps ids an officer supplied and rejects duplicates", () => {
    expect(
      parseEventType({ name: "Foundry", sessions: [{ id: "L1", label: "Legion 1" }] }, "o").sessions[0]?.id,
    ).toBe("L1");
    expect(() =>
      parseEventType({ name: "Foundry", sessions: [{ id: "L1", label: "A" }, { id: "L1", label: "B" }] }, "o"),
    ).toThrow(ValidationError);
  });

  it.each([
    ["no name", { leadDays: 1 }],
    ["a one-letter name", { name: "F" }],
    ["a negative lead time", { name: "Foundry", leadDays: -1 }],
    ["too many parts", { name: "Many", sessions: Array.from({ length: 7 }, (_, i) => ({ label: `W${i}` })) }],
    ["a part without a name", { name: "Foundry", sessions: [{ label: "" }] }],
  ])("rejects %s", (_case, input) => {
    expect(() => parseEventType(input, "o")).toThrow(ValidationError);
  });
});

describe("STARTER_TYPES", () => {
  const byId = (id: string) => STARTER_TYPES.find((t) => t.typeId === id)!;

  it("gives Foundry its two legions and a three-day lead", () => {
    expect(byId("foundry").leadDays).toBe(3);
    expect(byId("foundry").sessions.map((s) => s.label)).toEqual(["Legion 1", "Legion 2"]);
  });

  it("asks SvS, KOI and FDT how much of the event someone can give", () => {
    for (const id of ["svs", "koi", "fdt"]) {
      expect(byId(id).sessions.map((s) => s.label)).toEqual(["Full time", "First half", "Last half"]);
      expect(byId(id).sessions.map((s) => s.id)).toEqual(["full", "first", "last"]);
    }
    expect(byId("koi")).toMatchObject({ name: "King of Icefield (KOI)", leadDays: 3 });
  });

  it("leaves Canyon and Tundra League without parts, so they are a plain are-you-in", () => {
    expect(byId("canyon").sessions).toEqual([]);
    expect(byId("tundra").sessions).toEqual([]);
  });

  it("keeps the Bear hunt archived: it runs every other day and nobody signs up", () => {
    expect(byId("bear").archived).toBe(true);
    // Everything an officer can still schedule stays available.
    expect(STARTER_TYPES.filter((t) => t.archived).map((t) => t.typeId)).toEqual(["bear"]);
  });
});
