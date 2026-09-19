// The Cognito side of invites (P4.1). Logins sign in with emailed one-time codes; the password
// set here is random, never shown to anyone and never used.
import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginDirectory } from "./invite.js";

const unusablePassword = () => `${randomBytes(24).toString("base64url")}Aa1!`;

export function cognitoLogins(client: CognitoIdentityProviderClient, userPoolId: string): LoginDirectory {
  const subOf = (attributes: AttributeType[] | undefined) => attributes?.find((a) => a.Name === "sub")?.Value;

  return {
    async findSub(email) {
      const res = await client.send(
        new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${email.replaceAll('"', "")}"`, Limit: 2 }),
      );
      if ((res.Users?.length ?? 0) > 1) throw new Error(`More than one login uses ${email}`);
      return subOf(res.Users?.[0]?.Attributes);
    },

    async createLogin(email) {
      const created = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          MessageAction: "SUPPRESS", // no invitation mail: people sign in with a code
        }),
      );
      const sub = subOf(created.User?.Attributes);
      if (!sub) throw new Error(`Cognito returned no subject for ${email}`);
      // Confirms the login, so the first sign-in asks for a code instead of a password change.
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: created.User?.Username ?? email,
          Password: unusablePassword(),
          Permanent: true,
        }),
      );
      return sub;
    },

    async deleteLogin(sub) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: sub }));
    },
  };
}
