// Owner admin tasks against the live AWS stack, run locally with your own AWS login.
//   npm run admin -w api -- link --email you@example.com --player-id 123456789 --name "Name" [--rank R5] [--alliance POP]
// Finds the table and user pool from the PopHq stack outputs and asks before writing.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createBaseClient, createDocClient } from "../src/data/client.js";
import { Repository } from "../src/data/repository.js";
import { DomainError } from "../src/domain/errors.js";
import { linkLogin } from "../src/ops/linkLogin.js";

const REGION = "eu-central-1";
const STACK = "PopHq";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    "player-id": { type: "string" },
    name: { type: "string" },
    rank: { type: "string" },
    alliance: { type: "string" },
    yes: { type: "boolean", default: false },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (positionals[0] !== "link") fail('Usage: npm run admin -w api -- link --email <email> --player-id <id> --name "<name>" [--rank R1-R5]');
if (process.env.DYNAMODB_ENDPOINT) fail("DYNAMODB_ENDPOINT is set; this script works on the AWS stack only. Unset it first.");
const { email, name } = values;
const playerId = values["player-id"];
if (!email || !playerId || !name) fail("--email, --player-id and --name are required.");

const outputs = await new CloudFormationClient({ region: REGION })
  .send(new DescribeStacksCommand({ StackName: STACK }))
  .then((r) => Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])));
const tableName = outputs.TableName ?? fail(`Stack ${STACK} has no TableName output.`);
const userPoolId = outputs.UserPoolId ?? fail(`Stack ${STACK} has no UserPoolId output.`);

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const findSub = async (address: string) => {
  const res = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${address.replaceAll('"', "")}"`, Limit: 2 }),
  );
  if ((res.Users?.length ?? 0) > 1) fail(`More than one login uses ${address}.`);
  return res.Users?.[0]?.Attributes?.find((a) => a.Name === "sub")?.Value;
};

console.info(`Stack ${STACK}: table ${tableName}, user pool ${userPoolId}`);
console.info(`Link login ${email} to game account ${playerId} "${name}"${values.rank ? ` (${values.rank})` : ""}.`);
if (!values.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Continue? [y/N] ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") fail("Cancelled.");
}

const repo = new Repository(createDocClient(createBaseClient({ tableName, region: REGION })), tableName);
try {
  const res = await linkLogin(
    { repo, findSub, actor: { id: "owner-admin-script", via: "admin", reason: "owner bootstrap" } },
    {
      email: email!,
      playerId: playerId!,
      name: name!,
      ...(values.rank ? { rank: values.rank } : {}),
      ...(values.alliance ? { alliance: values.alliance } : {}),
    },
  );
  console.info(
    `${res.accountCreated ? "Created" : "Kept existing"} game account ${res.account.playerId} "${res.account.name}"; ` +
      `${res.linked ? "linked it to" : "it was already linked to"} ${email}.`,
  );
} catch (err) {
  if (err instanceof DomainError) fail(`${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}`);
  throw err;
}
