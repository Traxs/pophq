// Creates (or with --reset, recreates) the local table in DynamoDB Local.
import { createBaseClient, dataConfigFromEnv } from "../src/data/client.js";
import { createTable, deleteTable } from "../src/data/table.js";

const config = dataConfigFromEnv({ DYNAMODB_ENDPOINT: "http://localhost:8000", ...process.env });
if (!config.endpoint) {
  console.error("Refusing to run without DYNAMODB_ENDPOINT: this script is for local development only.");
  process.exit(1);
}

const client = createBaseClient(config);
if (process.argv.includes("--reset")) {
  await deleteTable(client, config.tableName);
  console.info(`Deleted ${config.tableName}`);
}
const result = await createTable(client, config.tableName);
console.info(`Table ${config.tableName}: ${result}`);
