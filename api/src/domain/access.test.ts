import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { parseResetJustification } from "./access.js";

describe("parseResetJustification", () => {
  it("trims a meaningful fraud-review reason", () => {
    expect(parseResetJustification("  Identity verified in Discord  ")).toBe("Identity verified in Discord");
  });

  it.each(["", "lost", "x".repeat(201)])("rejects an unsafe reason", (value) => {
    expect(() => parseResetJustification(value)).toThrow(ValidationError);
  });
});
