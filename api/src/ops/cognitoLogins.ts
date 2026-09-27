// The Cognito side of invites (P4.1). Email-code logins receive an unusable random permanent
// password; password logins receive a one-time temporary credential and Cognito requires the
// member to replace it under the pool's password policy.
import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  UsernameExistsException,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginDirectory } from "./invite.js";
import { ConflictError } from "../domain/errors.js";

const unusablePassword = () => `${randomBytes(24).toString("base64url")}Aa1!`;
const temporaryPassword = () => `${randomBytes(18).toString("base64url")}Aa1!`;
const privateUsername = (preferredName?: string) => preferredName
  ? `${preferredName}@members.pophq.invalid`
  : `member-${randomBytes(9).toString("base64url").toLowerCase()}@members.pophq.invalid`;

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

    async createPasswordLogin(preferredName) {
      // This pool uses email-format usernames. A reserved .invalid address satisfies that fixed
      // pool schema without collecting or pretending to own a real mailbox.
      const username = privateUsername(preferredName);
      const password = temporaryPassword();
      let created;
      try {
        created = await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: username,
            UserAttributes: [{ Name: "email", Value: username }],
            TemporaryPassword: password,
            MessageAction: "SUPPRESS",
          }),
        );
      } catch (err) {
        if (err instanceof UsernameExistsException) throw new ConflictError("That login name is already in use. Ask an R4 for a new invitation and choose another.");
        throw err;
      }
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

    async disableLogin(sub) {
      await client.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: sub }));
      await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: sub }));
    },

    async enableLogin(sub) {
      await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: sub }));
    },

    async deleteLogin(sub) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: sub }));
    },
  };
}
