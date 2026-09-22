import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player" };

describe("event types", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.cleanup());

  it("starts with the types POP plays today, and keeps them", async () => {
    const first = await h.call("GET", "/event-types", PLAYER);
    expect(first.status).toBe(200);
    const items = first.body.items as { typeId: string; name: string; leadDays: number; sessions: { label: string }[] }[];
    // The Bear hunt is kept but archived, so it is not something an officer can schedule.
    expect(items.map((t) => t.typeId).toSorted()).toEqual(["canyon", "fdt", "foundry", "koi", "other", "svs", "tundra"]);
    expect((first.body.archived as { typeId: string }[]).map((t) => t.typeId)).toEqual(["bear"]);
    const foundry = items.find((t) => t.typeId === "foundry")!;
    expect(foundry).toMatchObject({ name: "Foundry", leadDays: 3 });
    expect(foundry.sessions.map((s) => s.label)).toEqual(["Legion 1", "Legion 2"]);
    const koi = items.find((t) => t.typeId === "koi")!;
    expect(koi).toMatchObject({ name: "King of Icefield (KOI)", leadDays: 3 });
    expect(koi.sessions.map((s) => s.label)).toEqual(["Full time", "First half", "Last half"]);

    // Written once: a second read returns the stored ones, not a fresh copy.
    const again = await h.call("GET", "/event-types", PLAYER);
    expect((again.body.items as unknown[]).length).toBe(items.length);
  });

  it("lets officers add their own type", async () => {
    const res = await h.call("POST", "/event-types", {
      ...OFFICER,
      body: {
        name: "Canyon Clash",
        leadDays: 2,
        sessions: [{ label: "Wave 1", defaultMinutes: 720 }, { label: "Wave 2", defaultMinutes: 1140 }],
        strategyTemplate: "## Plan\n- ",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ typeId: "canyon-clash", leadDays: 2 });

    const dup = await h.call("POST", "/event-types", { ...OFFICER, body: { name: "Canyon Clash" } });
    expect(dup.status).toBe(409);

    const listed = await h.call("GET", "/event-types", PLAYER);
    expect((listed.body.items as { typeId: string }[]).map((t) => t.typeId)).toContain("canyon-clash");
  });

  it("lets officers change a type, including archiving it", async () => {
    const changed = await h.call("PATCH", "/event-types/bear", { ...OFFICER, body: { leadDays: 1, name: "Bear" } });
    expect(changed.body).toMatchObject({ typeId: "bear", name: "Bear", leadDays: 1 });

    await h.call("PATCH", "/event-types/other", { ...OFFICER, body: { archived: true } });
    const listed = await h.call("GET", "/event-types", PLAYER);
    expect((listed.body.items as { typeId: string }[]).map((t) => t.typeId)).not.toContain("other");
    expect((listed.body.archived as { typeId: string }[]).map((t) => t.typeId)).toContain("other");
  });

  it("is officer-only to change, and reports unknown types", async () => {
    expect((await h.call("POST", "/event-types", { ...PLAYER, body: { name: "Mine" } })).status).toBe(403);
    expect((await h.call("PATCH", "/event-types/bear", { ...PLAYER, body: { leadDays: 5 } })).status).toBe(403);
    expect((await h.call("PATCH", "/event-types/ghost", { ...OFFICER, body: { leadDays: 5 } })).status).toBe(404);
  });
});

describe("starter types an alliance is missing", () => {
  it("are added later, without disturbing the ones officers already changed", async () => {
    const h = await createHarness();
    // An alliance that started before FDT, Canyon and Tundra League existed, with a renamed
    // Foundry it would be rude to overwrite.
    await h.repo.putEventType(
      { typeId: "foundry", name: "Foundry night", leadDays: 5, sessions: [], archived: false, createdBy: "officer" },
      { id: "officer", via: "web" },
    );

    const res = await h.call("GET", "/event-types", { as: "player" });
    const items = res.body.items as { typeId: string; name: string; leadDays: number }[];
    expect(items.map((t) => t.typeId).toSorted()).toEqual(["canyon", "fdt", "foundry", "koi", "other", "svs", "tundra"]);
    // Untouched: the officer's own wording and lead time survive.
    expect(items.find((t) => t.typeId === "foundry")).toMatchObject({ name: "Foundry night", leadDays: 5 });
    expect((res.body.archived as { typeId: string }[]).map((t) => t.typeId)).toEqual(["bear"]);
    await h.cleanup();
  });
});
