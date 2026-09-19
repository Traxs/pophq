import { describe, expect, it } from "vitest";
import { parseAuthConfig, tokenAction } from "./auth";

describe("parseAuthConfig", () => {
  it("accepts an https issuer and a client id", () => {
    expect(parseAuthConfig({ issuer: "https://cognito-idp.eu-central-1.amazonaws.com/pool", clientId: "abc" })).toEqual({
      issuer: "https://cognito-idp.eu-central-1.amazonaws.com/pool",
      clientId: "abc",
    });
  });

  it.each([null, {}, { issuer: "http://insecure", clientId: "abc" }, { issuer: "https://x", clientId: "" }])(
    "rejects %j",
    (value) => {
      expect(() => parseAuthConfig(value)).toThrow();
    },
  );
});

describe("tokenAction", () => {
  it("uses a token with more than a minute left", () => {
    expect(tokenAction({ expires_in: 3000, refresh_token: "r" })).toBe("use");
    expect(tokenAction({ expires_in: 61, refresh_token: undefined })).toBe("use");
  });
  it("refreshes a nearly expired or expired token when a refresh token exists", () => {
    expect(tokenAction({ expires_in: 60, refresh_token: "r" })).toBe("refresh");
    expect(tokenAction({ expires_in: -500, refresh_token: "r" })).toBe("refresh");
    expect(tokenAction({ expires_in: undefined, refresh_token: "r" })).toBe("refresh");
  });
  it("treats an expired token without a refresh token, or no user, as signed out", () => {
    expect(tokenAction({ expires_in: 10, refresh_token: undefined })).toBe("none");
    expect(tokenAction(null)).toBe("none");
  });
});

describe("parseAuthConfig authDomain", () => {
  it("accepts an https auth domain and trims a trailing slash", () => {
    expect(
      parseAuthConfig({ issuer: "https://i", clientId: "c", authDomain: "https://pophq.auth.example.com/" }).authDomain,
    ).toBe("https://pophq.auth.example.com");
  });
  it("rejects a non-https auth domain", () => {
    expect(() => parseAuthConfig({ issuer: "https://i", clientId: "c", authDomain: "http://x" })).toThrow();
  });
});
