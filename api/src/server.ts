// Local development server. In AWS the same app runs on Lambda (src/lambda.ts), without dev tools.
import { serve } from "@hono/node-server";
import { createBaseClient, createDocClient, dataConfigFromEnv } from "./data/client.js";
import { Repository } from "./data/repository.js";
import { createTable, deleteTable } from "./data/table.js";
import { seedDemo } from "./dev/demo.js";
import { startHistoryPoller } from "./dev/historyPoller.js";
import { devLogins } from "./dev/logins.js";
import { registerDevRoutes } from "./dev/routes.js";
import { createRemoteVerifier } from "./http/auth.js";
import { HistoryStore } from "./data/history.js";
import { createApp } from "./http/app.js";

const env = {
  DYNAMODB_ENDPOINT: "http://localhost:8000",
  OIDC_ISSUER: "http://localhost:8081/pophq",
  ...process.env,
};

const config = dataConfigFromEnv(env);
if (!config.endpoint) throw new Error("The local server only runs against DynamoDB Local (DYNAMODB_ENDPOINT).");

const base = createBaseClient(config);
const db = createDocClient(base);
const repo = new Repository(db, config.tableName);

const reset = async () => {
  await deleteTable(base, config.tableName);
  await createTable(base, config.tableName);
  await seedDemo(repo, new Date());
};

const app = createApp({
  repo,
  verifier: createRemoteVerifier(env.OIDC_ISSUER),
  logins: devLogins(db, config.tableName),
  // Locally the history shares the table; the keys are prefixed, so nothing collides.
  history: new HistoryStore(db, config.tableName),
  extend: (a) => registerDevRoutes(a, { repo, reset }),
});

startHistoryPoller(base, db, config.tableName, { endpoint: config.endpoint });

const port = Number(process.env.API_PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.info(`API on http://localhost:${port}/v1 (table ${config.tableName}, issuer ${env.OIDC_ISSUER}, dev tools on)`);
});
