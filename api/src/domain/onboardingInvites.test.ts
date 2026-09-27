import { describe, expect, it } from "vitest";
import { createOnboardingToken, ONBOARDING_TOKEN_BYTES, parseOnboardingToken, parsePrivateLoginName } from "./onboardingInvites.js";

describe("onboarding invitation secrets", () => {
  it("creates independent 256-bit URL-safe bearer secrets and only exposes their digest", () => {
    const first = createOnboardingToken();
    const second = createOnboardingToken();
    expect(ONBOARDING_TOKEN_BYTES).toBe(32);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toContain(first.token);
    expect(parseOnboardingToken(first.token)).toBe(first.token);
  });

  it("strictly limits public token and private login-name input", () => {
    expect(() => parseOnboardingToken("short")).toThrow("invalid or has expired");
    expect(parsePrivateLoginName(" Frost-Wolf_2 ")).toBe("frost-wolf_2");
    expect(() => parsePrivateLoginName("no spaces allowed")).toThrow("3–24");
  });
});
