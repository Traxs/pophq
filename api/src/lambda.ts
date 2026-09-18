// AWS Lambda entry point. Configuration comes from environment variables set by CDK;
// they hold names and URLs only, never secret values (SEC-03).
import { handle } from "hono/aws-lambda";
import { createBaseClient, createDocClient, dataConfigFromEnv } from "./data/client.js";
import { Repository } from "./data/repository.js";
import { createRemoteVerifier } from "./http/auth.js";
import { createApp } from "./http/app.js";

const issuer = process.env.OIDC_ISSUER;
if (!issuer) throw new Error("OIDC_ISSUER is not set");

const config = dataConfigFromEnv();
const repo = new Repository(createDocClient(createBaseClient(config)), config.tableName);
const app = createApp({ repo, verifier: createRemoteVerifier(issuer, process.env.OIDC_AUDIENCE) });

export const handler = handle(app);
