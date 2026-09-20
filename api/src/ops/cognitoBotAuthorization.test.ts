import { describe, expect, it, vi } from "vitest";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { cognitoBotIssuerCanUse } from "./cognitoBotAuthorization.js";

describe("Cognito bot issuer authorization", () => {
  it.each([
    [[{ GroupName: "officer" }], true],
    [[{ GroupName: "owner" }], true],
    [[{ GroupName: "player" }], false],
    [[], false],
  ] as const)("maps live Cognito groups to result access", async (Groups, expected) => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Users: [{ Username: "login-name" }] })
      .mockResolvedValueOnce({ Groups });
    const canUse = cognitoBotIssuerCanUse({ send } as unknown as CognitoIdentityProviderClient, "pool-1");
    await expect(canUse("person-1", "results:write")).resolves.toBe(expected);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ UserPoolId: "pool-1", Filter: 'sub = "person-1"' });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ UserPoolId: "pool-1", Username: "login-name" });
  });

  it("denies a token whose issuing login no longer exists", async () => {
    const send = vi.fn().mockResolvedValue({ Users: [] });
    const canUse = cognitoBotIssuerCanUse({ send } as unknown as CognitoIdentityProviderClient, "pool-1");
    await expect(canUse("deleted-person", "results:read")).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});
