import { describe, expect, it } from "vitest";
import { parseAuthConfig } from "./auth";

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
