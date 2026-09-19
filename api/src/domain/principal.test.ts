import { describe, expect, it } from "vitest";
import { defaultActing, parseGroups, requireCanWriteFor, resolveActingAccount, type Principal } from "./principal.js";
import { ForbiddenError } from "./errors.js";

const principal = (groups: string[], linked: string[]): Principal => ({
  sub: "user-1",
  groups: parseGroups(groups),
  linkedAccounts: new Set(linked),
});

describe("resolveActingAccount (FM-04)", () => {
  it("accepts a linked account and ignores an empty header", () => {
    expect(resolveActingAccount("111111", new Set(["111111"]))).toBe("111111");
    expect(resolveActingAccount(undefined, new Set())).toBeUndefined();
    expect(resolveActingAccount("", new Set())).toBeUndefined();
  });

  it("refuses an account that isn't linked, even for officers", () => {
    expect(() => resolveActingAccount("222222", new Set(["111111"]))).toThrow(ForbiddenError);
  });
});

describe("requireCanWriteFor", () => {
  it("lets players write for their own accounts only", () => {
    expect(requireCanWriteFor(principal([], ["111111"]), "111111")).toBe("player");
    expect(() => requireCanWriteFor(principal([], ["111111"]), "222222")).toThrow(ForbiddenError);
  });

  it("records officers writing for others as officer entries", () => {
    expect(requireCanWriteFor(principal(["officer"], []), "222222")).toBe("officer");
    expect(requireCanWriteFor(principal(["officer"], ["111111"]), "111111")).toBe("player");
  });
});

describe("parseGroups", () => {
  it("always includes player and ignores unknown groups", () => {
    expect([...parseGroups(["officer", "admin", "owner"])].sort()).toEqual(["officer", "owner", "player"]);
    expect([...parseGroups(undefined)]).toEqual(["player"]);
    expect([...parseGroups("officer owner")].sort()).toEqual(["officer", "owner", "player"]);
  });
});

describe("defaultActing", () => {
  const withAccounts = (linked: string[], actingAs?: string): Principal => ({
    sub: "login-1",
    groups: new Set(["player"] as const),
    linkedAccounts: new Set(linked),
    ...(actingAs ? { actingAs } : {}),
  });

  it("uses the chosen account", () => {
    expect(defaultActing(withAccounts(["1", "2"], "2"))).toBe("2");
  });
  it("uses the only linked account when nothing is chosen", () => {
    expect(defaultActing(withAccounts(["7"]))).toBe("7");
  });
  it("stays neutral with several accounts and no choice", () => {
    expect(defaultActing(withAccounts(["1", "2"]))).toBeUndefined();
    expect(defaultActing(withAccounts([]))).toBeUndefined();
  });
});
