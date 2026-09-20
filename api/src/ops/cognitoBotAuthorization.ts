import {
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { BotIssuerCanUse } from "../http/agentAuth.js";

/** Bot result scopes require the issuer to remain an officer or owner in Cognito. */
export function cognitoBotIssuerCanUse(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): BotIssuerCanUse {
  return async (issuedBy) => {
    const users = await client.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `sub = "${issuedBy.replaceAll('"', "")}"`,
      Limit: 2,
    }));
    if (users.Users?.length !== 1 || !users.Users[0]?.Username) return false;
    const response = await client.send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: users.Users[0].Username,
      Limit: 60,
    }));
    const names = new Set((response.Groups ?? []).map((group) => group.GroupName));
    return names.has("officer") || names.has("owner");
  };
}
