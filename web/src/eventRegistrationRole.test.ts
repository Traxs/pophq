import { describe, expect, it } from "vitest";
import { registrationRolePresentation } from "./eventRegistrationRole";

describe("registration role display", () => {
  it("labels an explicit substitute choice instead of showing an estimate", () => {
    expect(registrationRolePresentation({ likely: "starter", registrationRole: "substitute" })).toEqual({
      label: "Substitute",
      tone: "warn",
    });
  });

  it("keeps capacity-based roles visibly estimated when no role was supplied", () => {
    expect(registrationRolePresentation({ likely: "starter" }).label).toBe("Likely starter");
    expect(registrationRolePresentation({ likely: "sub" }).label).toBe("Likely sub");
  });
});
