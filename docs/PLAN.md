# POP HQ build plan

The order of work, from first commit to launch. Each milestone ends with something deployed and tested. Story and requirement IDs (e.g. `EVT-05`, `FM-11`) refer to the build spec. Tick items off in the PR that completes them.

**Rules for every task:** unit tests with the change, integration tests for anything touching data or auth, runs locally first (`npm run dev:up`), no secrets in Git.

## Milestone 0: First slice (done)

- [x] Repo scaffold: workspaces, gitleaks pre-commit hook + CI, Dependabot, CODEOWNERS, PR template, SECURITY.md
- [x] Local stack: DynamoDB Local, mock sign-in (test personas), Discord sink; `dev:up`, `dev:reset`, `dev`
- [x] API: token check (OIDC discovery), game accounts, login links (one login per account), X-Account-Id check (FM-04)
- [x] Power reports as typed measurements, corrections (`supersedesReportId`), current values
- [x] Race-condition tests: duplicate Player ID, double link, double correction, transferred account (FM-12)
- [x] Web app: sign-in, account switcher, Home to-dos, Power page (trend, change, history, update sheet), officer Members table
- [x] Dev tools (local only): add members, backfill history, report round, reset
- [x] **First commit and push to `main`**, then CI runs once

## Milestone 1: Deployment pipeline, GitHub push to AWS (in progress)

Live: every push to `main` deploys through the pipeline to the default CloudFront URL, with a smoke test after each deploy.

Goal: every merge to `main` deploys automatically to AWS account 529088263366 (eu-central-1), and the app answers on a CloudFront URL.

- [ ] P1.1 Pre-build AWS check (half a day): CloudFront flat-rate plan in CDK, REST API Lambda authorizer with usage-plan keys, CodeDeploy canary + pre-traffic hook, Lambda code signing, Cognito Discord federation + pre sign-up trigger, current prices
- [ ] P1.2 AWS account baseline (owner, in the console): root MFA, IAM Identity Center access, billing alerts, Cost Anomaly Detection, Lambda concurrency quota increase request (10 -> 1,000)
- [x] P1.3 `infra/` CDK app (TypeScript): `PopHqPipeline` stack and a `Prod` stage with the `PopHq` app stack; cdk-nag (AwsSolutions) runs in the app and in the stage; stack tests. The `Cert` stack (us-east-1) arrives with the domain in P2.1
- [x] P1.4 CDK bootstrap in eu-central-1 and us-east-1
- [x] P1.5 GitHub connection: CodeConnections to `Traxs/pophq` through the AWS Connector app installed on the Traxs org (only this repo); a personal-account installation sends no push events
- [x] P1.6 Pipeline stack: CDK Pipelines, trigger on push to `main`, synth step runs `npm ci`, lint, unit tests, `cdk synth`; self-updating
- [x] P1.7 App stack v0: DynamoDB table (PITR, Streams, deletion protection, RETAIN), API Lambda (Node 24, arm64, Hono via `lambda.ts`), API Gateway REST, S3 web bucket + CloudFront with OAC, `/v1/*` routed to the API; default `cloudfront.net` domain until `pophq.fyi` is bought; minimal invite-only Cognito user pool so the API has a token issuer (hardened in Milestone 2)
- [x] P1.8 Web deploy: build `web/`, upload to S3, CloudFront invalidation; `index.html` and `config.json` revalidated, hashed assets cached for a year and never pruned (FM-15); sign-in settings from runtime `/config.json`
- [x] P1.9 Post-deploy smoke test in the pipeline: `/v1/health`, the web page, `config.json`, and `/v1/me` returns 401 without a token
- [ ] P1.10 PR checks in GitHub Actions: `cdk synth` + cdk-nag (done); `cdk diff` against prod via a read-only OIDC role (no AWS keys in GitHub)
- [ ] P1.11 Repo settings after the first push: `main` ruleset (PR, required checks, no force-push), secret scanning + push protection, CodeQL, dependency review, private vulnerability reporting, Actions read-only + SHA pinning, fork approval for all outside contributors
- [x] P1.12 Cost guard: AWS Budget ($10 alerts), kill switch as an SSM flag checked by the API and tripped at $15 (FM-13); API key only CloudFront sends + usage plan quota of 20,000 requests/day as a hard cost ceiling. Excluding domain registration from the budget (FM-27) moves to P2.1
- [ ] P1.13 Lambda code signing and CodeDeploy canary (10% for 5 min, alarms roll back) with a pre-traffic integration hook (PLT-02, PLT-07)

## Milestone 2: Identity and edge in production

- [ ] P2.1 Buy `pophq.fyi` in Route 53; hosted zone; ACM certificate (us-east-1); exclude domain registration from the budget (FM-27)
- [ ] P2.2 CloudFront on the flat-rate Free plan with WAF (5 rules), security headers policy (CSP, HSTS, frame-ancestors); origin verification (FM-31) is done via the CloudFront-only API key, and moves into the Lambda authorizer with P2.5
- [ ] P2.3 Cognito user pool (Essentials): email one-time code, passkeys, self sign-up off, SMS off, deletion protection; managed login on the custom domain; limit the web client to the auth flows the hosted login needs
- [ ] P2.4 SES: domain verification, DKIM/SPF/DMARC, production access (FM-32)
- [ ] P2.5 Lambda authorizer: Cognito JWT (check `token_use` and `client_id`; the v0 API only checks issuer and signature), context with principal/groups/linked accounts, 60 s cache keyed on `Authorization` + `X-Account-Id` (FM-03, FM-04, FM-07); usage plans (people 10k/day)
- [ ] P2.6 Officer MFA (TOTP), groups `player` / `officer` / `owner` (ID-06, ID-07)
- [ ] P2.7 Log in with Discord: OIDC wrapper Lambda, Pre sign-up trigger rejects unlinked identities (FM-06), account linking from a signed-in session (ID-04)
- [ ] P2.8 Web: Cognito sign-in in production, refresh-token handling with one tab refreshing at a time (FM-16)

## Milestone 3: Data foundation

- [ ] P3.1 Item metadata everywhere: version, updatedBy, via, changeId, reason; ETag / If-Match with 412 (DATA-03)
- [ ] P3.2 Idempotency keys scoped to principal + route + body hash (FM-05)
- [ ] P3.3 History pipeline: Streams -> history-writer -> put-only History table; quarantine to S3 after 3 failures (FM-01, DATA-04); version chain + nightly reconcile
- [ ] P3.4 Firehose -> Parquet lake (long format, FM-22), Glue catalog, Athena workgroup with 50 MB scan limit; nightly incremental export
- [ ] P3.5 `asOf` reads and timelines from the History table (DATA-02)
- [ ] P3.6 Personal data: per-subject data keys in a separate Keys table (no PITR/exports), envelope encryption, erasure by key deletion (FM-02, DATA-05)
- [ ] P3.7 Transactional outbox: outbox items written in the same transaction, relay to SQS FIFO, sender Lambda for Discord with `allowed_mentions` off, retries, DLQ (FM-19, FM-20, INT-01..03)
- [ ] P3.8 Evidence registry: presigned POST, finalize (size, type, SHA-256, EXIF strip, pixel cap), `incoming/` expiry (FM-14)
- [ ] P3.9 Roster summary item instead of one query per account (from Milestone 0)

## Milestone 4: Membership lifecycle and officer inbox

- [ ] P4.1 Access requests with profile screenshot, officer approval, bulk approve (ID-01, ID-02, FM-26, LCH-01)
- [ ] P4.2 Seat cap of 100 enabled logins with a conditional counter (FM-08)
- [ ] P4.3 Alt linking with verification and conflict handling (ID-12)
- [ ] P4.4 Transfer out / welcome back; login disabled only when no active account remains; Cognito calls via outbox (ID-08, ID-09, FM-07)
- [ ] P4.5 Archive after 12 months, owner erasure (ID-10, ID-11)
- [ ] P4.6 Officer inbox with badges and Discord notes (OFC-01); roster edits, ranks, notes, guests (ROS-01..05)
- [ ] P4.7 Dev tools: simulate access requests, transfers and returns

## Milestone 5: Events, lineups and attendance

- [ ] P5.1 Event types (officer-defined), occurrences with legion sessions and deadlines (EVT-01, EVT-02)
- [ ] P5.2 Answers per game account with deadline check in the same transaction (EVT-03, FM-09)
- [ ] P5.3 Officer view: counts and lists by answer, battle time, furnace, Helios (EVT-04)
- [ ] P5.4 Lineups: one item per session, versioned, capacity 30 + 10 enforced in the write (EVT-04, EVT-05, FM-10); public view with own entry highlighted
- [ ] P5.5 Strategy versions (Markdown + assignment table) on the event page (EVT-06)
- [ ] P5.6 Actual attendance (Unknown default) and results (EVT-07, EVT-08); attendance score (last 10 confirmed commitments)
- [ ] P5.7 Reminders every 15 minutes from due-reminder index, versioned keys (EVT-09, FM-18); not-answered list
- [ ] P5.8 Dev tools: demo Foundry with 2 legions, random answers, auto-fill lineup, simulate outcome
- [ ] P5.9 Foundry map with zones (EVT-10, Should)

## Milestone 6: SvS buff slots

- [ ] P6.1 SvS rounds with three buff days and 48 slots each (BUF-01)
- [ ] P6.2 Preferences, up to 3 per day, locked at the deadline (BUF-02, FM-09)
- [ ] P6.3 Planning board with demand, conflicts, unassigned list (BUF-03); one slot per game account per day in one transaction (FM-11)
- [ ] P6.4 Guests from other alliances (BUF-04); publish with plan version check (BUF-05); my slots on Home (BUF-06)
- [ ] P6.5 Change / swap requests (BUF-07); calendar file (BUF-08)
- [ ] P6.6 Dev tools: generate preferences; auto-assign by attendance score in shadow mode (BUF-09)

## Milestone 7: Officer console completion

- [ ] P7.1 Change log browser and validated revert (OFC-03)
- [ ] P7.2 Settings: webhooks (write-only), alliance codes, scoring window (OFC-04)
- [ ] P7.3 Proposals: review diff, bounded size, stale check, no self-approval (OFC-02, FM-35)
- [ ] P7.4 Owner status panel: spend, quotas, kill switch (OFC-06)

## Milestone 8: Metrics and exports

- [ ] P8.1 Named Athena metrics with explicit cohort, denominator and baseline rules (power-growth, top-gainers, stale-reports, attendance-rate, answer-vs-actual, identity-changes, buff-history, buff-fairness)
- [ ] P8.2 Alliance dashboard and player profile metrics (MET-01..04); async jobs for slow queries (FM-24)
- [ ] P8.3 Exports: sync CSV/JSONL and async bulk with `asOf`, row budget reservation (MET-05, FM-25)

## Milestone 9: Agent API and Hermes skill

- [ ] P9.1 Agent tokens: issue, list, revoke, scopes, HMAC hash, 90-day expiry, 30-day unused revoke, agents-off switch (AGT-01, AGT-05)
- [ ] P9.2 Route allow-list per scope, output guard for untrusted text, row budgets, per-token quotas
- [ ] P9.3 Dry-run, proposals for large changes, `lineup:write` for Hermes (AGT-03, EVT-05)
- [ ] P9.4 OpenAPI 3.1 published; `/v1/guide`
- [ ] P9.5 Hermes skill: SKILL.md, `s26` CLI (stdlib Python), references generated from OpenAPI, checksummed release (AGT-04)
- [ ] P9.6 Negative and prompt-injection test suites (SEC tests in Failure review)

## Milestone 10: Hardening and launch

- [ ] P10.1 Playwright end-to-end tests on phone and desktop in CI
- [ ] P10.2 Security review against OWASP LLM/agentic guidance; half-day Hermes red-team session
- [ ] P10.3 Selective Hermes history import: verified Player IDs, manifest, dry-run, batched commit (LCH-04)
- [ ] P10.4 Launch: officers first, launch post, bulk approval, first-report push (LCH-02)
- [ ] P10.5 Archive the Cloudflare app's D1 data as CSV, then retire it with the owner's go-ahead (LCH-03)

## Open follow-ups from Milestone 0

- [ ] Spec: local stack uses DynamoDB Local (not LocalStack); SQS/S3 emulators when the outbox and evidence arrive
- [ ] Spec: report sort keys are `REPORT#<ulid>`; ordering by effective date happens in the domain
- [ ] Web: move to an OpenAPI-generated API client once P9.4 exists
- [ ] TypeScript 7: switch once typescript-eslint supports it (it allows `<6.1` today). CI already type-checks with 7 (`npm run typecheck:ts7`), so the switch is a version bump
