import { describe, expect, it } from "vitest";
import { parseGameName, parsePlayerId, searchKey } from "./identity.js";
import { ValidationError } from "./errors.js";

describe("parsePlayerId", () => {
  it.each(["405338501", "12345", 405338501])("accepts %s", (v) => {
    expect(parsePlayerId(v)).toBe(String(v));
  });

  it.each(["01234", "1234", "12a45", "", "1234567890123456", null])("rejects %s", (v) => {
    expect(() => parsePlayerId(v)).toThrow(ValidationError);
  });
});

describe("parseGameName", () => {
  it("keeps the raw spelling after NFKC normalisation", () => {
    expect(parseGameName("  IceQueen ")).toBe("IceQueen");
    expect(parseGameName("Ｐｏｐｐｙ")).toBe("Poppy"); // full-width letters
  });

  it.each([
    ["zero-width space", "Ice\u200bQueen"],
    ["bidi override", "Ice\u202eQueen"],
    ["Unicode tag characters", "Ice\u{e0041}Queen"],
    ["control character", "Ice\u0007Queen"],
  ])("rejects hidden %s", (_label, name) => {
    expect(() => parseGameName(name)).toThrow(/invisible or control/);
  });

  it("enforces 2–30 characters", () => {
    expect(() => parseGameName("A")).toThrow(ValidationError);
    expect(() => parseGameName("x".repeat(31))).toThrow(ValidationError);
    expect(parseGameName("x".repeat(30))).toHaveLength(30);
  });
});

describe("searchKey", () => {
  it("case-folds and collapses whitespace", () => {
    expect(searchKey("  Ice   QUEEN ")).toBe("ice queen");
  });
});
