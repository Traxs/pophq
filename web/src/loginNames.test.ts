import { describe, expect, it } from "vitest";
import { cognitoLoginIdentifier, displayLoginName } from "./loginNames";

describe("friendly login names", () => {
  it("hides Cognito's private email-shaped suffix", () => {
    expect(displayLoginName("aoife@members.pophq.invalid")).toBe("aoife");
  });

  it("turns a friendly password username into Cognito's internal identifier", () => {
    expect(cognitoLoginIdentifier(" Aoife ")).toBe("aoife@members.pophq.invalid");
  });

  it("leaves real email-code addresses intact", () => {
    expect(cognitoLoginIdentifier(" Player@Example.com ")).toBe("player@example.com");
    expect(displayLoginName("player@example.com")).toBe("player@example.com");
  });
});
