# POP HQ

Alliance command center for the POP alliance in Whiteout Survival (State 2612): power reports, SvS buff planning, event lineups and attendance, reminders, and a full change history. Serverless on AWS, defined in CDK.

> Status: first vertical slice. Game accounts, login links and power reports work locally end to end. The CDK pipeline (GitHub push to AWS) is defined in `infra/`. The build order is in [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | Contents |
| --- | --- |
| `api/` | API (Hono; runs on Node locally and on AWS Lambda) with the domain core |
| `web/` | Web app (React + TypeScript, Vite) |
| `dev/` | Local stack: DynamoDB Local, a mock sign-in server, a Discord webhook sink |
| `infra/` | AWS CDK app: CodePipeline (push to `main` deploys) and the app stack |
| `docs/` | Build plan, implementation context, and local debugging guide |
| `agent/hermes-skill/` | Hermes skill and the `s26` CLI (not started) |
| `scripts/` | Repository tooling (git hooks, dev runner) |

## Local development

Requirements: Node 24 (`nvm use`), Docker, Python with `pre-commit`, and `gitleaks`. No AWS credentials are needed.

```bash
npm run setup      # dependencies + git hooks
npm run dev:up     # starts the Docker stack, creates the table, loads fake seed data
npm run dev        # API on http://localhost:3000/v1, web app on http://localhost:5180
```

The local sign-in page shows a **test sign-in picker** (local development only). Each person is fake and comes from the demo data set:

| Person | Role | Game accounts |
| --- | --- | --- |
| Poppy | Player | 100000001 Poppy, 100000002 Goatzilla (alt) |
| Aurora | Officer, R4 | 100000008 Aurora; sees the Members table |
| Polaris | Site owner (in-game R5) | 100000010 Polaris |
| Newcomer | Signed in, no account yet | none |

The **Dev** tab (local only) loads more data while the app runs: add random members, backfill months of history for the selected account, run a report round, or reset to the demo set. Its API routes exist only on the local server, never on AWS.

Other commands: `npm run dev:reset` (wipe and re-seed), `npm run dev:down` (stop the stack). Discord messages sent locally can be read at http://localhost:8082/messages.

For architecture/domain orientation and troubleshooting, see [Implementation context](docs/IMPLEMENTATION_CONTEXT.md) and [Local debugging](docs/LOCAL_DEBUGGING.md).

## Tests

```bash
npm run test:unit          # domain rules, no Docker needed
npm run test:integration   # API and race conditions against DynamoDB Local (npm run dev:up first)
npm run lint && npm run typecheck
```

Every change ships with tests. The pre-commit hook runs gitleaks, lint, type checks and the unit tests of changed packages; pre-push runs the full unit suite. CI repeats everything, plus the integration tests.

## Deployment

New API code first serves 10 % of requests for five minutes. If it errors during that window, CodeDeploy sends everyone back to the previous version and the deploy fails.

Merging to `main` is the only way to deploy. The pipeline in AWS (CodePipeline, eu-central-1) pulls `main` through a GitHub connection, runs lint, type checks, unit tests and the build, then synthesizes the CDK app, updates itself, deploys the `PopHq` stack and runs a smoke test against the live URL.

```bash
npm run build && npm run synth -w infra   # what CI and the pipeline synthesize, including cdk-nag checks
```

One-time setup (done once by the account owner; needs AWS admin credentials):

```bash
npx -w infra cdk bootstrap aws://529088263366/eu-central-1 aws://529088263366/us-east-1
npm run build && npx -w infra cdk deploy PopHqPipeline
```

Install the **AWS Connector for GitHub** app on the **Traxs organization** (only the `pophq` repository). Then approve the pending `pophq-github-org` connection in the AWS console (Developer Tools → Connections) with that org installation, and release the pipeline once. An installation on a personal account can read the repo but sends no push events, so pushes would not start the pipeline.

Before the first deploy of the app stack, store the budget alert email in SSM (kept out of this public repository), then confirm the two SNS subscription emails AWS sends:

```bash
aws ssm put-parameter --region eu-central-1 --name /pophq/alerts/email --type String --value "you@example.com"
```

## Roles and the first owner

Roles are Cognito groups defined in the stack: `player` (every signed-in person), `officer` (roster and planning tools) and `owner` (runs the site). They are app permissions, not game ranks: R1–R5 is stored on the game account.

Create a login (no invitation email; sign-in uses emailed one-time codes, so the random password is never used), add it to a group, and link it to its game account:

```bash
POOL=$(aws cloudformation describe-stacks --region eu-central-1 --stack-name PopHq --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --region eu-central-1 --user-pool-id "$POOL" --username you@example.com --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region eu-central-1 --user-pool-id "$POOL" --username you@example.com --password "$(openssl rand -base64 30)" --permanent
aws cognito-idp admin-add-user-to-group --region eu-central-1 --user-pool-id "$POOL" --username you@example.com --group-name owner
npm run admin -w api -- link --email you@example.com --player-id 123456789 --name "YourName" --rank R4
```

Group changes apply at the next sign-in.

Logins created before seats were counted (the first owner) don't hold a seat yet; run this once:

```bash
npm run admin -w api -- backfill-seats
```

## Inviting members

Officers invite from the Members page: email (optional), Player ID, game name and rank. One step creates the Cognito login (sign-in by emailed code, no password), the game account and the link between them; repeating the same invite changes nothing. Without an email only the game account is created, for members who report through an officer. Logins are capped at 100 seats (FM-08); alts of the same person don't use extra seats.

Locally the invite flow uses a stand-in directory in DynamoDB Local, so invited emails can't actually sign in there; the test personas cover signed-in flows.

## Events

Officers schedule events (Foundry, Bear hunt, SvS, other) with a start time. Answers close a set number of days before the start, per type: **Foundry three days**, because officers register the participants in game afterwards; other types an hour before unless changed. The deadline falls at the end of that day in the officer's time zone, and can be overridden per event. Officers can edit an event later; moving the start moves the deadline with it. Event types are defined by officers: each carries how many days before the start answers close, which parts people choose between, and a strategy template. New events inherit from a type and can still be changed.

After an event, officers mark who turned up (present, absent, excused, or left unknown when nobody checked). Reliability is the share of kept commitments over the last ten **checked** events: an excused absence or an event nobody checked never lowers it, so a missing screenshot cannot cost a member their spot.

Who starts and who substitutes is estimated as **0.7 × (Foundry strength ÷ strongest signed up) + 0.3 × attendance rate**, with unknown attendance counted as reliable; officers publish the real lineup, which then replaces the estimate everywhere. Members see the sign-up table with strength and likely role; the reliability score is officer-only. After the deadline members can no longer change their answer, but officers keep editing who is coming until the event starts.

Tables carry small six-month graphs: **Strength 6m** is the Foundry strength at the end of each month (a level, carried forward when nothing was reported), and **Attendance 6m** is a trailing average — each month averaged with the two before it — on a fixed 0–100% scale with a faint halfway mark, green above half and red below. One bad night therefore bends the line instead of dropping it to the floor. A month with nothing recorded is a gap, never a zero, and a single reading shows as a dot rather than a fake trend.

Opening an event shows each part with its capacity (a Foundry legion takes 30 starters and 10 substitutes, set per event), how full it is, who signed up, and — until officers publish the lineup — an estimate of your role ranked by Foundry strength, clearly marked as an estimate. Officers additionally see a table of every member with their answer, legion, Foundry strength, power, furnace and last report, with totals per legion.

After publishing a lineup, officers publish a separate strategy for each part: a short plan plus Holder, Looter, Substitute Looter and Farmer assignments. Everyone sees the plan and assignment table, with their own row highlighted. Strategy edits are version-checked, so one officer cannot silently overwrite another officer's newer plan.

**Publishing a lineup** turns that estimate into a decision. An officer opens the part, sets each person to Starting, Substitute or Not playing — the list opens on the published lineup, or on the estimate when there is none — and publishes. Everyone then sees the lineup with their own row highlighted, and their pill changes from "Likely starting" to "You're starting · #4"; the capacity bar counts the lineup rather than the sign-ups. Each publish is a new version, kept in the change history like any other write. Publishing sends the version that was edited, so a second officer working from a stale page is told to reload instead of overwriting the first. Capacity is enforced in the write, and someone picked although they never answered is shown as "didn't answer" rather than hidden.

A Foundry is **one event with two legions**: members pick Legion 1 or Legion 2 (or "Can't"), never both, and switching legions replaces the earlier pick. Other events keep the plain Yes / Maybe / No. Members answer per game account, so someone with alts answers once per account, and may change their mind until the deadline. The deadline is checked in the same write as the answer, so a late answer cannot slip through (FM-09). Officers see counts and the lists behind them, including who has not answered, and may answer on someone's behalf.

## Importing a Hermes bundle

```bash
npm run import:foundry -w api -- --bundle /path/to/foundry            # dry run: prints the plan
npm run import:foundry -w api -- --bundle /path/to/foundry --apply    # writes to the local table
npm run import:foundry -w api -- --bundle /path/to/foundry --apply --aws   # writes to the PopHq stack
```

The same command also brings in events (one per day, with a part per legion), the attendance recorded for them, and sign-ups. Attendance keeps the moment, source and evidence it was recorded with, rather than the time of the import.

The import keeps its distance from guesses: accounts without a numeric Player ID are listed for an officer instead of invented, imported accounts get membership `unknown` (another system's snapshot does not prove who is in the alliance today), an account POP HQ already knows keeps its name and rank, and every observation keeps its own date, precision and source. Record ids come from the bundle, so importing the same bundle twice changes nothing.

Alliance charts count confirmed members and guests; accounts with unknown membership are counted separately and included only on request (`?cohort=all`).

## Change history

Every write to the main table streams into a separate, put-only history table: what changed, when, who did it, through which route and why. Nothing there is ever updated or deleted, so a correction never hides the value it replaced. `GET /v1/accounts/{playerId}/timeline` returns it, newest first: members for their own accounts, officers for anyone.

Locally the dev server polls DynamoDB Local's stream and runs the same handler as AWS, so timelines work in development too.

## Cost guard

- **Request cap:** API Gateway only accepts requests carrying an API key that CloudFront adds. The usage plan allows 20 requests per second and **20,000 requests per day**, which caps API cost at about $3 a month even under a flood. Calls to the execute-api URL get 403.
- **Budget:** `pophq-monthly`, $10 a month. Email at 50 % and 100 % actual spend and at 100 % forecast.
- **Kill switch:** at $15 actual spend, a Lambda sets `/pophq/kill-switch` to `on` and the API answers 503 to every request. Budget data lags by up to a day, so this is a backstop behind the request cap. Turn it back off by hand:

```bash
aws ssm put-parameter --region eu-central-1 --name /pophq/kill-switch --type String --value off --overwrite
```

The same command with `--value on` pauses the API manually. Changes take effect within a minute.

## Secrets

Never commit secrets. The pre-commit hook and CI both run gitleaks; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
