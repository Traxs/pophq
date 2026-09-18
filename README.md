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
| `docs/` | Build plan |
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
| Polaris | Owner, R5 | 100000010 Polaris |
| Newcomer | Signed in, no account yet | none |

The **Dev** tab (local only) loads more data while the app runs: add random members, backfill months of history for the selected account, run a report round, or reset to the demo set. Its API routes exist only on the local server, never on AWS.

Other commands: `npm run dev:reset` (wipe and re-seed), `npm run dev:down` (stop the stack). Discord messages sent locally can be read at http://localhost:8082/messages.

## Tests

```bash
npm run test:unit          # domain rules, no Docker needed
npm run test:integration   # API and race conditions against DynamoDB Local (npm run dev:up first)
npm run lint && npm run typecheck
```

Every change ships with tests. The pre-commit hook runs gitleaks, lint, type checks and the unit tests of changed packages; pre-push runs the full unit suite. CI repeats everything, plus the integration tests.

## Deployment

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
