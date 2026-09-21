import { describe, expect, it } from "vitest";
import { parseAccountChanges, parseNewAccount, type GameAccount } from "./accounts.js";
import { ValidationError } from "./errors.js";

describe("parseNewAccount", () => {
  it("takes a member with the defaults POP uses", () => {
    expect(parseNewAccount({ playerId: "100000001", name: "Poppy" })).toEqual({
      playerId: "100000001",
      name: "Poppy",
      alliance: "POP",
      status: "active",
    });
  });

  it("refuses a POP guest, since guests belong to another alliance", () => {
    expect(() => parseNewAccount({ playerId: "100000001", name: "Poppy", status: "guest" })).toThrow(ValidationError);
    expect(
      parseNewAccount({ playerId: "200000001", name: "MirGuest", alliance: "MIR", status: "guest" }),
    ).toMatchObject({ alliance: "MIR", status: "guest" });
  });

  it("refuses a Player ID or name the game would not allow", () => {
    expect(() => parseNewAccount({ playerId: "abc", name: "Poppy" })).toThrow(ValidationError);
    expect(() => parseNewAccount({ playerId: "100000001", name: "x" })).toThrow(ValidationError);
  });
});

describe("parseAccountChanges", () => {
  const member: GameAccount = { playerId: "100000001", name: "Poppy", alliance: "POP", status: "active", rank: "R3" };

  it("changes only what was sent", () => {
    expect(parseAccountChanges(member, { rank: "R4" })).toEqual({ ...member, rank: "R4" });
    expect(parseAccountChanges(member, { status: "unknown" })).toEqual({ ...member, status: "unknown" });
  });

  it("renames an account, keeping the name rules", () => {
    expect(parseAccountChanges(member, { name: "  Poppy II  " }).name).toBe("Poppy II");
    expect(() => parseAccountChanges(member, { name: "x" })).toThrow(ValidationError);
  });

  it("clears a rank nobody knows, and keeps an unrelated one", () => {
    expect(parseAccountChanges(member, { rank: "" }).rank).toBeUndefined();
    expect(parseAccountChanges(member, { status: "unknown" }).rank).toBe("R3");
  });

  it("keeps an officer's note, and lets it be removed", () => {
    const noted = parseAccountChanges(member, { note: "On holiday until October" });
    expect(noted.note).toBe("On holiday until October");
    expect(parseAccountChanges(noted, { note: "" }).note).toBeUndefined();
  });

  it("holds the line on guests: they belong to another alliance", () => {
    expect(() => parseAccountChanges(member, { status: "guest" })).toThrow(/can't be a guest/);
    expect(() => parseAccountChanges(member, { alliance: "MIR" })).toThrow(/is a guest here/);
    // Both together is the coherent change.
    expect(parseAccountChanges(member, { alliance: "MIR", status: "guest" })).toMatchObject({
      alliance: "MIR",
      status: "guest",
    });
  });

  it("refuses an empty change and an unknown status", () => {
    expect(() => parseAccountChanges(member, {})).toThrow(/Nothing to change/);
    expect(() => parseAccountChanges(member, { status: "archived" })).toThrow(ValidationError);
    expect(() => parseAccountChanges(member, { rank: "R9" })).toThrow(ValidationError);
  });
});
