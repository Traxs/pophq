import { describe, expect, it } from "vitest";
import type { SessionView } from "./api";
import { countDraft, draftFor, entriesToPublish } from "./lineup";

const signUp = (playerId: string, name: string, position: number, likely: "starter" | "sub") => ({
  playerId,
  name,
  foundryStrength: 9_000_000 - position,
  position,
  likely,
});

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "L1",
  label: "Legion 1",
  startsAt: "2026-09-27T12:00:00Z",
  starters: 2,
  subs: 1,
  signedUp: 3,
  spotsLeft: 0,
  signedUpList: [
    signUp("100000001", "Poppy", 1, "starter"),
    signUp("100000002", "Goatzilla", 2, "starter"),
    signUp("100000003", "Aurora", 3, "sub"),
  ],
  lineup: null,
  ...over,
});

describe("draftFor", () => {
  it("starts from the estimate when nothing is published", () => {
    expect(draftFor(session()).map((r) => `${r.name}:${r.role}`)).toEqual([
      "Poppy:starter",
      "Goatzilla:starter",
      "Aurora:sub",
    ]);
  });

  it("starts from the published lineup once there is one", () => {
    const rows = draftFor(
      session({
        lineup: {
          version: 2,
          publishedAt: "2026-09-25T10:00:00Z",
          entries: [
            { playerId: "100000003", name: "Aurora", role: "starter", position: 1, foundryStrength: 1, signedUp: true },
            { playerId: "100000001", name: "Poppy", role: "sub", position: 1, foundryStrength: 2, signedUp: true },
          ],
        },
      }),
    );
    expect(rows.map((r) => `${r.name}:${r.role}`)).toEqual(["Aurora:starter", "Poppy:sub", "Goatzilla:out"]);
  });

  it("keeps someone who was picked without signing up", () => {
    const rows = draftFor(
      session({
        signedUpList: [],
        lineup: {
          version: 1,
          publishedAt: "2026-09-25T10:00:00Z",
          entries: [
            { playerId: "100000009", name: "Kilwa", role: "starter", position: 1, foundryStrength: null, signedUp: false },
          ],
        },
      }),
    );
    expect(rows).toEqual([
      { playerId: "100000009", name: "Kilwa", foundryStrength: null, role: "starter", signedUp: false },
    ]);
  });
});

describe("countDraft", () => {
  it("counts each role and flags a draft that does not fit", () => {
    const rows = draftFor(session());
    expect(countDraft(rows, { starters: 2, subs: 1 })).toEqual({ starters: 2, subs: 1, overCapacity: false });
    expect(countDraft(rows, { starters: 1, subs: 1 }).overCapacity).toBe(true);
    expect(countDraft(rows, { starters: 2, subs: 0 }).overCapacity).toBe(true);
  });

  it("never flags a session without a capacity", () => {
    expect(countDraft(draftFor(session()), {}).overCapacity).toBe(false);
  });
});

describe("entriesToPublish", () => {
  it("sends starters first, then substitutes, and leaves out everyone else", () => {
    const rows = draftFor(session()).map((r) => (r.name === "Goatzilla" ? { ...r, role: "out" as const } : r));
    expect(entriesToPublish(rows)).toEqual([
      { playerId: "100000001", role: "starter" },
      { playerId: "100000003", role: "sub" },
    ]);
  });
});
