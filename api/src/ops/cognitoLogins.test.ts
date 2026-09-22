import { AdminCreateUserCommand, type CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import { cognitoLogins } from "./cognitoLogins.js";

describe("cognitoLogins.createPasswordLogin", () => {
  it("creates a suppressed temporary-password user without a personal or verified email", async () => {
    const send = vi.fn().mockResolvedValue({
      User: { Attributes: [{ Name: "sub", Value: "sub-password-user" }] },
    });
    const logins = cognitoLogins({ send } as unknown as CognitoIdentityProviderClient, "pool-1");

    const result = await logins.createPasswordLogin();

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect(command.input).toMatchObject({
      UserPoolId: "pool-1",
      Username: result.username,
      UserAttributes: [{ Name: "email", Value: result.username }],
      TemporaryPassword: result.password,
      MessageAction: "SUPPRESS",
    });
    expect(result).toMatchObject({ sub: "sub-password-user" });
    expect(result.username).toMatch(/^member-[a-z0-9_-]+@members\.pophq\.invalid$/);
    expect(result.password.length).toBeGreaterThanOrEqual(20);
    expect(command.input.UserAttributes).not.toContainEqual({ Name: "email_verified", Value: "true" });
  });
});
