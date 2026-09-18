// Loads the fake demo data set into the local table. Never run against AWS.
// Dev personas (pick them on the local sign-in page):
//   player  -> 100000001 Poppy (main) and 100000002 Goatzilla (alt)
//   officer -> 100000008 Aurora (R4)
//   owner   -> 100000010 Polaris (R5)
//   anyone else -> signed in, but no game account linked yet
import { createBaseClient, createDocClient, dataConfigFromEnv } from "../src/data/client.js";
import { Repository } from "../src/data/repository.js";
import { seedDemo } from "../src/dev/demo.js";

const config = dataConfigFromEnv({ DYNAMODB_ENDPOINT: "http://localhost:8000", ...process.env });
if (!config.endpoint) {
  console.error("Refusing to seed without DYNAMODB_ENDPOINT: this script is for local development only.");
  process.exit(1);
}

const repo = new Repository(createDocClient(createBaseClient(config)), config.tableName);
if (await repo.getAccount("100000001")) {
  console.info("Demo data already present; run `npm run dev:reset` to start over.");
  process.exit(0);
}
const result = await seedDemo(repo, new Date());
console.info(`Seeded ${result.accounts} accounts (${result.members} POP members) into ${config.tableName}.`);
