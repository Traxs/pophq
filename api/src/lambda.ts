// AWS Lambda entry point. Configuration comes from environment variables set by CDK;
// they hold names and URLs only, never secret values (SEC-03).
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { createBaseClient, createDocClient, dataConfigFromEnv } from "./data/client.js";
import { Repository } from "./data/repository.js";
import { createRemoteVerifier } from "./http/auth.js";
import { HistoryStore } from "./data/history.js";
import { createApp } from "./http/app.js";
import { cognitoLogins } from "./ops/cognitoLogins.js";
import { createPauseCheck } from "./ops/pause.js";
import { cognitoBotIssuerGroups } from "./ops/cognitoBotAuthorization.js";

const issuer = process.env.OIDC_ISSUER;
if (!issuer) throw new Error("OIDC_ISSUER is not set");

const config = dataConfigFromEnv();
const repo = new Repository(createDocClient(createBaseClient(config)), config.tableName);
const killSwitch = process.env.KILL_SWITCH_PARAMETER;
if (!killSwitch) throw new Error("KILL_SWITCH_PARAMETER is not set");
const ssm = new SSMClient({});
const isPaused = createPauseCheck(
  async () => (await ssm.send(new GetParameterCommand({ Name: killSwitch }))).Parameter?.Value,
  { onError: (err) => console.error(JSON.stringify({ level: "error", message: "kill switch read failed", err: String(err) })) },
);

const userPoolId = process.env.USER_POOL_ID;
if (!userPoolId) throw new Error("USER_POOL_ID is not set");
const cognito = new CognitoIdentityProviderClient({});

const historyTable = process.env.HISTORY_TABLE_NAME;
if (!historyTable) throw new Error("HISTORY_TABLE_NAME is not set");
const historyDb = createDocClient(createBaseClient({ ...config, tableName: historyTable }));

const app = createApp({
  repo,
  history: new HistoryStore(historyDb, historyTable),
  verifier: createRemoteVerifier(issuer, process.env.OIDC_AUDIENCE),
  isPaused,
  logins: cognitoLogins(cognito, userPoolId),
  botIssuerGroups: cognitoBotIssuerGroups(cognito, userPoolId),
});

export const handler = handle(app);
