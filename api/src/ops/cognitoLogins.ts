// The Cognito side of invites (P4.1). Logins sign in with emailed one-time codes; the password
// set here is random, never shown to anyone and never used.
import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginDirectory } from "./invite.js";

const unusablePassword = () => `${randomBytes(24).toString("base64url")}Aa1!`;
const temporaryPassword = () => `${randomBytes(18).toString("base64url")}Aa1!`;
const privateUsername = () => `member-${randomBytes(9).toString("base64url").toLowerCase()}@members.pophq.invalid`;

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

    async createPasswordLogin() {
      // This pool uses email-format usernames. A reserved .invalid address satisfies that fixed
      // pool schema without collecting or pretending to own a real mailbox.
      const username = privateUsername();
      const password = temporaryPassword();
      const created = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: [{ Name: "email", Value: username }],
          TemporaryPassword: password,
          MessageAction: "SUPPRESS",
        }),
      );
      const sub = subOf(created.User?.Attributes);
      if (!sub) throw new Error("Cognito returned no subject for the password login");
      return { sub, username, password };
    },

    async resetPassword(sub) {
      const password = temporaryPassword();
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: sub,
        Password: password,
        Permanent: false,
      }));
      // Password recovery must also cut off a stolen refresh/access-token session.
      await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: sub }));
      return { password };
    },

    async deleteLogin(sub) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: sub }));
    },
  };
}
