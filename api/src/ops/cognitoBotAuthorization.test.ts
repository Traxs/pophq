import { describe, expect, it, vi } from "vitest";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { cognitoBotIssuerGroups } from "./cognitoBotAuthorization.js";

describe("Cognito bot issuer authorization", () => {
  it.each([
    [[{ GroupName: "officer" }], ["officer", "player"]],
    [[{ GroupName: "owner" }], ["owner", "player"]],
    [[{ GroupName: "player" }], ["player"]],
    [[], ["player"]],
  ] as const)("maps live Cognito groups to bot permissions", async (Groups, expected) => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Users: [{ Username: "login-name" }] })
      .mockResolvedValueOnce({ Groups });
    const groupsFor = cognitoBotIssuerGroups({ send } as unknown as CognitoIdentityProviderClient, "pool-1");
    const groups = await groupsFor("person-1");
    expect([...(groups ?? [])].toSorted()).toEqual([...expected].toSorted());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ UserPoolId: "pool-1", Filter: 'sub = "person-1"' });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ UserPoolId: "pool-1", Username: "login-name" });
  });

  it("denies a token whose issuing login no longer exists", async () => {
    const send = vi.fn().mockResolvedValue({ Users: [] });
    const groupsFor = cognitoBotIssuerGroups({ send } as unknown as CognitoIdentityProviderClient, "pool-1");
    await expect(groupsFor("deleted-person")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});
