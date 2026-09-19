// Imports a Hermes export bundle (LCH-04). Shows what it would do; writes only with --apply.
//   npm run import:foundry -w api -- --bundle /path/to/foundry [--apply] [--aws]
// Without --aws it works on the local table; with --aws on the PopHq stack, after confirmation.
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { createBaseClient, createDocClient } from "../src/data/client.js";
import { Repository } from "../src/data/repository.js";
import { applyImport, planImport, type BundleObservation, type BundlePlayer } from "../src/ops/importFoundry.js";

const REGION = "eu-central-1";

const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    apply: { type: "boolean", default: false },
    aws: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const bundle = values.bundle ?? fail("Usage: npm run import:foundry -w api -- --bundle <dir> [--apply] [--aws]");
const read = <T>(file: string): T => JSON.parse(readFileSync(join(bundle, "json", file), "utf8")) as T;

const plan = planImport(read<BundlePlayer[]>("players.json"), read<BundleObservation[]>("strength_observations.json"));

console.info(`Bundle ${bundle}`);
console.info(`  accounts with a Player ID : ${plan.accounts.length}`);
console.info(`  observations to import    : ${plan.reports.length}`);
console.info(`  accounts without a Player ID (need an officer): ${plan.withoutPlayerId.length}`);
for (const a of plan.withoutPlayerId.slice(0, 10)) console.info(`      - ${a.name}`);
if (plan.withoutPlayerId.length > 10) console.info(`      … and ${plan.withoutPlayerId.length - 10} more`);
if (plan.skipped.length > 0) {
  console.info(`  not usable: ${plan.skipped.length}`);
  for (const s of plan.skipped.slice(0, 5)) console.info(`      - ${s.id}: ${s.reason}`);
}
const metrics = new Set(plan.reports.map((r) => r.metric));
const dates = new Set(plan.reports.map((r) => r.effectiveAt.slice(0, 10)));
console.info(`  metrics: ${[...metrics].join(", ")} on ${[...dates].toSorted().join(", ")}`);

if (!values.apply) {
  console.info("\nDry run: nothing was written. Add --apply to import.");
  process.exit(0);
}

let tableName = process.env.TABLE_NAME ?? "pophq-local";
let endpoint: string | undefined = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
if (values.aws) {
  endpoint = undefined;
  const outputs = await new CloudFormationClient({ region: REGION })
    .send(new DescribeStacksCommand({ StackName: "PopHq" }))
    .then((r) => Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])));
  tableName = outputs.TableName ?? fail("Stack PopHq has no TableName output.");
}

console.info(`\nTarget: ${values.aws ? `AWS table ${tableName}` : `local table ${tableName} (${endpoint})`}`);
if (!values.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Import now? [y/N] ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") fail("Cancelled.");
}

const repo = new Repository(
  createDocClient(createBaseClient({ tableName, region: REGION, ...(endpoint ? { endpoint } : {}) })),
  tableName,
);
const result = await applyImport(repo, plan, { id: "foundry-import", via: "migration", reason: "Hermes bundle" });
console.info(
  `Accounts: ${result.accountsCreated} created, ${result.accountsKept} already known. ` +
    `Observations: ${result.reportsWritten} written, ${result.reportsAlreadyThere} already there.`,
);
