import {
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { parseGroups } from "../domain/principal.js";
import type { BotIssuerGroups } from "../http/agentAuth.js";

/** Resolve live Cognito groups so reads and scoped writes inherit the issuer's current rights. */
export function cognitoBotIssuerGroups(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): BotIssuerGroups {
  return async (issuedBy) => {
    const users = await client.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `sub = "${issuedBy.replaceAll('"', "")}"`,
      Limit: 2,
    }));
    if (users.Users?.length !== 1 || !users.Users[0]?.Username) return undefined;
    const response = await client.send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: users.Users[0].Username,
      Limit: 60,
    }));
    return parseGroups((response.Groups ?? []).map((group) => group.GroupName));
  };
}
