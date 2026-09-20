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
- [x] P1.13a CodeDeploy canary: new API code serves 10 % of requests for 5 minutes; an error alarm rolls it back and fails the deploy (PLT-02)
- [ ] P1.13b Lambda code signing (PLT-07): needs a signing step for the CDK asset in the pipeline (AWS Signer profile + signing job), otherwise enforcement blocks every deploy
- [ ] P1.13c Pre-traffic hook running integration tests against the new version before it takes traffic

## Milestone 2: Identity and edge in production

- [ ] P2.1 Buy `pophq.fyi` in Route 53; hosted zone; ACM certificate (us-east-1); exclude domain registration from the budget (FM-27)
- [ ] P2.2 CloudFront on the flat-rate Free plan with WAF (5 rules), security headers policy (CSP, HSTS, frame-ancestors); origin verification (FM-31) is done via the CloudFront-only API key, and moves into the Lambda authorizer with P2.5
- [ ] P2.3 Cognito user pool (Essentials): email one-time code, passkeys, self sign-up off, SMS off, deletion protection; managed login on the custom domain; limit the web client to the auth flows the hosted login needs
- [ ] P2.4 SES: domain verification, DKIM/SPF/DMARC, production access (FM-32)
- [ ] P2.5 Lambda authorizer: Cognito JWT (check `token_use` and `client_id`; the v0 API only checks issuer and signature), context with principal/groups/linked accounts, 60 s cache keyed on `Authorization` + `X-Account-Id` (FM-03, FM-04, FM-07); usage plans (people 10k/day)
- [ ] P2.6 Officer MFA (TOTP), groups `player` / `officer` / `owner` (ID-06, ID-07)
- [ ] P2.7 Log in with Discord: OIDC wrapper Lambda, Pre sign-up trigger rejects unlinked identities (FM-06), account linking from a signed-in session (ID-04)
- [x] P2.8 Web: Cognito sign-in in production, refresh-token handling with one tab refreshing at a time (FM-16)
- [x] P2.2a Strict Content Security Policy and security headers on CloudFront (brought forward from P2.2 with the decision below)

## Milestone 3: Data foundation

- [ ] P3.1 Item metadata everywhere: version, updatedBy, via, changeId, reason; ETag / If-Match with 412 (DATA-03)
- [ ] P3.2 Idempotency keys scoped to principal + route + body hash (FM-05)
- [x] P3.3a History pipeline: every change streams into a put-only History table with who/when/how/what; retries can't duplicate; failures park in a dead-letter queue (FM-01, DATA-04). Locally the dev server polls DynamoDB Local's stream and runs the same handler
- [x] P3.3b Timeline API: `GET /v1/accounts/:pid/timeline` (own account, or any for officers), paged
- [ ] P3.3c Nightly reconcile of the version chain, and timelines for events and answers in the UI
- [ ] P3.4 Firehose -> Parquet lake (long format, FM-22), Glue catalog, Athena workgroup with 50 MB scan limit; nightly incremental export
- [ ] P3.5 `asOf` reads and timelines from the History table (DATA-02)
- [ ] P3.6 Personal data: per-subject data keys in a separate Keys table (no PITR/exports), envelope encryption, erasure by key deletion (FM-02, DATA-05)
- [ ] P3.7 Transactional outbox: outbox items written in the same transaction, relay to SQS FIFO, sender Lambda for Discord with `allowed_mentions` off, retries, DLQ (FM-19, FM-20, INT-01..03)
- [ ] P3.8 Evidence registry: presigned POST, finalize (size, type, SHA-256, EXIF strip, pixel cap), `incoming/` expiry (FM-14)
- [ ] P3.9 Roster summary item instead of one query per account (from Milestone 0)

## Milestone 4: Membership lifecycle and officer inbox

- [x] P4.1a Officer invites: one step creates the login (emailed codes), the game account and the link; repeating it changes nothing; officers-only; Members page form
- [ ] P4.1b Access requests with profile screenshot, officer approval, bulk approve (ID-01, ID-02, FM-26, LCH-01) — for people who already have a login (alts, re-links); needs evidence uploads (P3.8)
- [x] P4.2 Seat cap of 100 logins with a conditional counter (FM-08); shown on the Members page; `npm run admin -w api -- backfill-seats` counts logins created before seats existed
- [ ] P4.3 Alt linking with verification and conflict handling (ID-12)
- [ ] P4.4 Transfer out / welcome back; login disabled only when no active account remains; Cognito calls via outbox (ID-08, ID-09, FM-07)
- [ ] P4.5 Archive after 12 months, owner erasure (ID-10, ID-11)
- [ ] P4.6 Officer inbox with badges and Discord notes (OFC-01); roster edits, ranks, notes, guests (ROS-01..05)
- [ ] P4.7 Dev tools: simulate access requests, transfers and returns

## Milestone 5: Events, lineups and attendance

- [x] P5.1a Events with kind (Foundry, Bear, SvS, Other), start time and answer deadline (EVT-02); officers can edit an event afterwards
- [x] P5.1b Answers close a set number of days before the start, per type (Foundry three days, because officers register people in game afterwards), at the end of that day in the officer's time zone; overridable per event
- [x] P5.1c Legion sessions: a Foundry is one event with two legions; a player signs up for exactly one, and switching replaces the earlier pick. Officers see counts and lists per legion
- [x] P5.1d Officer-defined event types (EVT-01): each carries its lead time, its parts and a strategy template; the four POP plays today are written on first use
- [x] P5.3b Event page: parts with capacity (Foundry 30 starters + 10 subs, set per event), how full each is, who signed up, and an honest estimate of your role by Foundry strength until officers publish the lineup
- [x] P5.3c Officer table on the event page: answer, legion, Foundry strength, power, furnace, last report, with totals per legion
- [x] P5.2 Answers per game account with the deadline checked in the same write (EVT-03, FM-09); players answer for their own accounts, officers for anyone
- [x] P5.3a Officer view: counts and lists by answer including who has not answered (EVT-04); battle time, furnace and Helios columns still to come
- [ ] P5.4 Lineups: one item per session, versioned, capacity 30 + 10 enforced in the write (EVT-04, EVT-05, FM-10); public view with own entry highlighted
- [ ] P5.5 Strategy versions (Markdown + assignment table) on the event page (EVT-06)
- [ ] P5.6 Actual attendance (Unknown default) and results (EVT-07, EVT-08); attendance score (last 10 confirmed commitments)
- [ ] P5.7 Reminders every 15 minutes from due-reminder index, versioned keys (EVT-09, FM-18); not-answered list
- [x] P5.8a Dev tools: demo events and random answers; lineup and outcome tools follow with P5.4/P5.6
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
- [x] P8.2a Charts: player power over time (own page) and alliance growth with top growers, not-growing and never-reported (MET-01), officer-only; plain SVG chart with tap-for-value and a hidden data table for screen readers
- [ ] P8.2b Attendance and event-outcome charts (need those features first); async jobs for slow queries (FM-24)
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
- [x] P10.3a Hermes bundle import: dry run by default, stable ids so repeating changes nothing, accounts without a numeric Player ID reported instead of invented, imported membership stays "unknown" (LCH-04)
- [ ] P10.3b Import the rest of a bundle: name history, alt links, events with lineups, attendance and outcomes
- [ ] P10.4 Launch: officers first, launch post, bulk approval, first-report push (LCH-02)
- [ ] P10.5 Archive the Cloudflare app's D1 data as CSV, then retire it with the owner's go-ahead (LCH-03)

## Decisions made during the build

- **2026-09-20, who starts and who substitutes:** ranked by **0.7 × (Foundry strength ÷ strongest signed up) + 0.3 × attendance rate**. Unknown attendance counts as fully reliable, so nobody is punished for missing data; until attendance is tracked the ranking is strength alone. It is shown as an estimate everywhere until officers publish the lineup (P5.4).
- **2026-09-20, sign-up list visibility:** every member sees who signed up with their Foundry strength, attendance and likely role, because that is what decides the lineup. Power, furnace, notes and the change log stay with officers.
- **2026-09-20, the answer lock binds members, not officers:** after the deadline members can no longer change their answer, while officers (and later Hermes tokens) keep editing who is coming until the event starts, recorded as an officer entry.

- **2026-09-19, POP HQ is the record, Hermes is the reasoning:** Hermes pulls roster, power, events, attendance and history to build strategy, and writes back only as **proposals** an officer accepts (recorded as "via agent, approved by X"). Data arrives from four sources: members themselves, Hermes reading screenshots, officers typing for others, and occasional CSV import.
- **2026-09-19, conflicting values:** the newest observation of a value wins, whoever reported it; the previous one stays in the timeline with its source and time. Ordering is by observed time, then recorded time, then record id.
- **2026-09-19, who sees what:** members see their own timeline and charts only; officers see every member's history, the change log, notes and alt links.
- **2026-09-19, retention:** every observation is kept in full, no summarising. At alliance size this is a few thousand records a year.
- **2026-09-19, event outcomes are stored:** our and the opponent's matchmaking power, opponent count, result, notes and per-player points where known, with their evidence.

- **2026-09-19, sign-in survives reloads (changes the spec's "tokens in memory"):** tokens live in localStorage so a reload, a new tab or the next day keeps people signed in. Safeguards: strict CSP (only our own scripts), Cognito refresh-token rotation with a 60 s grace period, refresh tokens valid 90 days from the last code sign-in, access tokens valid 1 hour and renewed on demand under a cross-tab lock, "Sign out" revokes the refresh token and ends the Cognito session, signing out in one tab signs out all tabs. Revisit (move to an HttpOnly-cookie session through the API) if the app ever loads third-party scripts.

## Strength metrics

Strength is several different numbers and they are never mixed: `city_power` (overall power) and `foundry_strength` (the Foundry comparison score, which Hermes calls `combat_power`). Further kinds (SvS, rally) are added to the metric registry in `api/src/domain/measurements.ts` as they appear. Event-level matchmaking power belongs to the event, not to a player.

## Open follow-ups from Milestone 0

- [ ] Spec: local stack uses DynamoDB Local (not LocalStack); SQS/S3 emulators when the outbox and evidence arrive
- [ ] Spec: report sort keys are `REPORT#<ulid>`; ordering by effective date happens in the domain
- [ ] Web: move to an OpenAPI-generated API client once P9.4 exists
- [ ] TypeScript 7: switch once typescript-eslint supports it (it allows `<6.1` today). CI already type-checks with 7 (`npm run typecheck:ts7`), so the switch is a version bump
