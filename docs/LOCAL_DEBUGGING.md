# Local development and debugging

This workflow was inspected and exercised on 2026-09-20 with Node 24.21.0, npm 11.19.0, Docker 27.3.1, and Compose 2.30.3. The project pins Node 24 and declares Node `>=24.11 <25`; run every project command after `nvm use`.

## Services and ports

| URL/port | Purpose |
| --- | --- |
| `http://localhost:5180` | Vite React app |
| `http://localhost:3000/v1` | local Hono API |
| `http://localhost:8000` | DynamoDB Local |
| `http://localhost:8081/pophq` | mock OIDC issuer |
| `http://localhost:8082/messages` | captured local Discord posts |

Vite proxies `/v1` to port 3000, matching the same-origin production shape. The local API refuses to start without `DYNAMODB_ENDPOINT`, which guards against accidental AWS access. Dev routes and the Dev tab are included only by the local server/build mode and are absent from Lambda/production.

## First start

From the repository root:

```bash
nvm use
npm run setup
npm run dev:up
npm run dev
```

`dev:up` starts the three Docker services, creates `pophq-local`, and idempotently seeds demo data. `npm run dev` starts API and web watchers together. Expected API startup text includes the API URL, table, issuer, and “dev tools on.”

No AWS credentials or real Discord webhook are needed. Defaults are built into the code; `.env.example` documents overrides. A root `.env` is ignored, but note that the repository does not explicitly load dotenv in `scripts/dev.mjs`; shell-exported environment variables are reliable, while a plain `.env` may depend on how Node is launched.

## Test personas

Use the local sign-in picker:

| Persona | Subject/role | Useful checks |
| --- | --- | --- |
| Poppy | `player` | own data and switching between main `100000001` and alt `100000002` |
| Aurora | `officer`, group `officer` | Members/roster, invites, events, attendance |
| Polaris | `owner`, group `owner` | owner authorization paths |
| Newcomer | `newcomer`, no linked account | signed-in empty state |

The picker changes the OIDC `client_id`; the mock issuer maps that to subject/groups. Seed data links the first three subjects to accounts.

The Members invite sheet supports the same email-code/password choices and roster autocomplete as production. Local issuance is persisted in the stand-in login directory so linkage, seat counting, one-time credential display and registered/unregistered UI can be tested. Invite an unregistered demo member with password access, open that member's profile, and use **Access security → Reset password** to test the mandatory reason, one-time replacement password, and completed audit entry. The mock OIDC server authenticates only the fixed personas, so a newly generated local login cannot complete a real sign-in or demonstrate Cognito's global session revocation; verify those boundaries in the Cognito command and infrastructure tests rather than treating the picker as Cognito.

### Local Bot Token debugging

Sign in locally as Aurora or Polaris, open Members, and issue a Bot Token. Enable only the write scopes being tested; historical imports are off by default. The local API resolves the token issuer against the same persona roles as the browser, so demotion/permission tests behave like production instead of failing for a missing Cognito directory.

```bash
export POPHQ_URL=http://localhost:3000
read -r -s POPHQ_BOT_TOKEN
export POPHQ_BOT_TOKEN
python3 agent/hermes-skill/state2612/scripts/s26.py doctor
```

Do not put the token in shell history or `.env`. Local evidence uploads are stored privately under ignored `.local/evidence/`; set `EVIDENCE_DIR` to use another disposable directory. DynamoDB Local still stores the evidence metadata and all other imported records. Resetting the local database does not delete evidence files, so use fresh stable record IDs or move the disposable evidence directory when testing a new import.

If persona behavior looks wrong, clear the following browser state and sign in again:

- keys beginning `oidc.user:`;
- `pophq.clientId` (chosen persona);
- `pophq.actingAs` (selected game account).

React StrictMode executes effects twice in development. The callback exchange is intentionally guarded by a module-level promise; do not remove it when debugging duplicate auth callbacks.

## Everyday commands

```bash
npm run dev:reset                    # delete/recreate the local table and seed it
npm run dev:down                     # stop the Docker stack
npm run lint
npm run typecheck
npm run typecheck:ts7                # keep the TypeScript 7 preview green
npm run check:deps                   # catch imports resolved only through hoisted dependencies
npm run test:unit
npm run test:integration             # requires dev:up
npm run secrets:scan                 # gitleaks; also runs in the pre-commit hook and CI
npm run build
npm run synth -w infra
```

`check:deps` is a release-safety check: an earlier Cognito SDK import resolved through the root `node_modules` even though the importing workspace had not declared it, so local checks passed and CI failed. Every workspace must declare the packages it imports in its own `package.json`.

Target a test while iterating:

```bash
npm run test:unit -w api -- --project unit src/domain/events.test.ts
npm run test:unit -w web -- src/eventTiming.test.ts
cd api && npx vitest run --project integration test/integration/events.test.ts
```

In Vitest, `-w` means watch mode; it does not select an npm workspace. Put `-w api` or `-w web` before `--` on an npm command, or change into the workspace before invoking `npx vitest`. If integration setup hooks time out, first confirm that all three Docker services are healthy, then rerun the normal parallel suite.

## API debugging

`GET /v1/health` is unauthenticated. Every other normal API route needs a verified bearer token. Game-account selection is sent as `X-Account-Id`; it must be linked to the subject. Officers can act for other accounts only on routes whose domain rule explicitly permits it.

API errors use `application/problem+json` and include a stable `x-request-id`. Unexpected errors are logged as JSON with the same request ID. Use the browser Network panel and API terminal together to correlate them.

Useful route groups currently include:

- `/v1/me`, `/accounts`, `/accounts/:pid`, `/accounts/:pid/reports`, `PUT /accounts/:pid/reports/:reportId/ignored`, `/accounts/:pid/timeline`;
- `/v1/roster`, `/v1/invites`, `/v1/metrics/alliance`;
- `/v1/event-types`, `/v1/events`, event answers, attendance, and account reliability;
- local-only `/v1/dev/*` routes for members, history, report rounds, events, answers, and reset.

The web API client is handwritten pending OpenAPI work. When a new backend route is intended for the UI, update the types/client in `web/src/api.ts`, expose it through `session.tsx` if authenticated, and add tests.

## Data inspection

DynamoDB Local is in-memory. Stopping/recreating its container loses data; `dev:reset` is the intentional clean-state command. Prefer the application APIs and tests for normal inspection. When diagnosing storage layout, table keys are defined in `api/src/data/keys.ts`:

- `ACCOUNT#<pid>` for account profile, reports, link lock, and timelines;
- `LOGIN#<sub>` for account links and seat ownership;
- `EVENT#<id>` for metadata, answers, and attendance;
- `EVENTTYPES` for event-type definitions;
- GSI1 for alliance roster, event order, and per-account answers/attendance.

History shares the local main table under distinct prefixed keys; in AWS it has a separate table. `api/src/dev/historyPoller.ts` consumes the DynamoDB Local stream so timelines behave locally like the deployed stream handler.

## Common failures

### Docker permission or connection failure

Confirm Docker Desktop is running, then:

```bash
docker compose -f dev/docker-compose.yml ps
```

In a sandboxed agent environment, access to the Docker socket and localhost may require explicit permission. `connect EPERM 127.0.0.1:8000` is an environment restriction, not a DynamoDB assertion failure.

### Port already in use

Check 3000, 5180, 8000, 8081, and 8082. The Vite port is strict and will fail rather than silently choose another. Override only API/configured endpoints consistently.

### OIDC discovery or callback failure

Check `http://localhost:8081/pophq/.well-known/openid-configuration`, then clear stored OIDC/persona keys. The API performs discovery on first token verification.

### Empty or stale data

Run `npm run dev:reset`. Seed is intentionally idempotent, so ordinary `dev:up` says “Demo data already present” rather than overwriting changes.

### Integration tests time out after a few days of use

DynamoDB Local keeps everything in memory and does not give it back: each integration file
creates and drops its own table, so after a couple of days and a few hundred runs the container
sits on a gigabyte and slows to the point where `beforeAll` hooks and whole tests exceed their
timeouts. The failures wander between files from run to run, which is the giveaway — a real
regression fails the same test every time.

```bash
docker restart pophq-dev-dynamodb-1 && npm run dev:reset
```

Measured on 2026-09-21: 1.04 GiB resident and three to four timeouts per run before the restart;
180 MiB and all 130 tests passing in 7.6 s after it. Do not reach for `--maxWorkers=1` — it hides
this rather than fixing it, and the suite is meant to run in parallel.

### Timeline has no new entry

Ensure the API watcher is running: it starts the local history poller. Allow roughly its one-second polling interval, then check API terminal warnings.

### Production-only behavior

Do not use local dev routes to infer Lambda behavior. Production uses runtime `/config.json`, Cognito, separate History storage, the SSM kill switch, API Gateway/CloudFront origin controls, and Cognito login management. Validate infrastructure behavior with stack tests/synth and production smoke tests, not the local dev tab.

## Verified baseline on 2026-09-20

- lint: passed;
- TypeScript checks for API, web, and infra: passed;
- TypeScript 7 preview checks for API, web, and infra: passed;
- dependency declaration check: passed;
- API/domain unit tests: 174 passed;
- web unit tests: 80 passed;
- infrastructure tests: 21 passed;
- integration tests: 16 files and 112 tests passed in the normal parallel run (about 53 s);
- gitleaks: full repository scan passed with no leaks found;
- Docker services: DynamoDB Local, mock OIDC, and Discord sink healthy.
