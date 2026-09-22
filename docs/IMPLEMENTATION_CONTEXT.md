# POP HQ implementation context

This is the durable orientation note for feature work. It summarizes the checked-in handoff pack, the compatibility review, the legacy Cloudflare application, the Foundry fixture, and the AWS code as inspected on 2026-09-20. Read this with `docs/PLAN.md`; code and tests remain authoritative for behavior already implemented.

## Source precedence

When sources disagree, use this order:

1. Current `api/`, `web/`, and `infra/` code plus tests for shipped behavior.
2. `docs/PLAN.md` for implementation status and decisions made during the build.
3. `../../POP-HQ-compatibility-review.md` for corrections made after examining real POP/Hermes data.
4. `../../pophq-handoff.zip` → `01-build-spec.md` for intended product behavior not superseded above.
5. The handoff AWS design for architecture detail.
6. `../../state2612-app/` for legacy behavior to preserve or deliberately replace.

The handoff explicitly says its build spec wins over its design. The build plan has since changed some decisions, notably importing selected Hermes/Foundry history instead of starting entirely empty and keeping browser tokens in local storage under a strict CSP.

## Product in one paragraph

POP HQ is a phone-first alliance command center for POP in Whiteout Survival State 2612. It replaces the public, mostly unauthenticated State 2612 Cloudflare Worker/D1 app with an invite-only AWS application. The intended product covers game-account identity and membership, typed strength reports, Foundry and other event sign-ups, attendance, lineups and strategies, SvS buff planning, Discord reminders, officer workflows, append-only history, metrics/exports, and guarded Hermes automation. POP HQ is the system of record; Hermes is the reasoning layer and should write proposals that an officer reviews.

## Repositories and artifacts

- `../`: AWS reimplementation root and the directory in which new work belongs.
- `../../state2612-app/`: deployed Cloudflare/D1 predecessor. Its working tree already contains user changes; do not modify or reset it casually.
- `../../pophq-handoff.zip`: original product spec, AWS design, and a snapshot/review of the old app.
- `../../POP-HQ-compatibility-review.md`: real-data review. Its verdict is “Works with changes.”
- `../../foundry-data-20260919T200926Z.zip`: private, real operational fixture. It contains player names, IDs, attendance, sign-ups, evidence, plans, normalized JSON/CSV, and an SQLite backup. Never publish or upload it to third parties.

## Legacy Cloudflare application

The predecessor is a Hono Worker with an embedded single-page UI and Cloudflare D1. It is served on `state2612.thmlab.org`, has a daily 09:00 UTC cron, and uses Worker secrets for officer sessions and exports.

Its main behaviors are:

- public player identity remembered in the browser, without individual login;
- one power submission per player and monthly cycle, overwritten within the cycle;
- one first-come 30-minute SvS slot per person/day for Mon Construction, Tue Research, Thu Training;
- slot-change/help requests and officer assignment;
- event attendance forms, restricted POP rosters, event checklists, and manual/cron Discord reminders;
- password-based officer accounts, audit log, login throttling, configuration, CSV/Google Sheets export, and destructive admin reset routes.

Its D1 entities are `players`, `power_updates`, `buff_slots`, `buff_help`, `attendance`, `events`, `roster`, `officers`, `audit_log`, `login_attempts`, and `config`. The old schema often stores numeric measurements as text and uses cycle-based uniqueness, so it is evidence about product behavior, not a schema to copy.

Important legacy limitations that the rebuild fixes include shared/weak identity, public mutation paths, coarse overwrite semantics, token-in-URL exports, mutable history, and conflation of a person/login with a game account.

## Target AWS architecture

The checked-in CDK defines a production-only deployment in AWS account `529088263366`, region `eu-central-1`:

- CloudFront fronts the static React application in S3 and `/v1` in API Gateway.
- Hono runs on Node Lambda; new versions use a 10%/5-minute CodeDeploy canary.
- Cognito is the production identity provider; local development uses a mock OIDC server.
- DynamoDB stores current state in a single table. Streams feed an append-only History table.
- The pipeline uses CodeConnections/CDK Pipelines and deploys merges to `main`.
- Cost controls include a CloudFront-only API key/usage plan, a $10 budget, and a persistent SSM kill switch tripped at $15.

Planned but incomplete pieces include the transactional Discord outbox, evidence/S3 upload pipeline, Athena/Parquet metrics lake, complete identity lifecycle, agent tokens/proposals, and several production hardening items. Consult `docs/PLAN.md` before assuming a service exists.

## Current implementation snapshot

At commit `8f99dd9`, the repository has 39 completed and 59 open plan checkboxes. Implemented vertical slices include:

- local DynamoDB/OIDC/Discord-sink stack and local-only test personas/tools;
- login-to-game-account links, account switching, officer invites, and a conditional 100-seat cap;
- typed measurement reports, superseding corrections, and audited soft deletion/restoration by the submitting player or an R4/R5;
- member power history, officer roster, alliance growth, and six-month mini line graphs; attendance uses a three-month trailing average rather than independent monthly bars;
- event types, event creation/editing, and deadlines computed as the end of the day N days before the start (`foundry: 3`, `svs: 3`, `bear: 0`, `other: 0`);
- one Foundry event with one session per legion; a member may answer yes for at most one session, and changing legion replaces the earlier choice;
- capacity display, estimated starter/sub role, officer attendance, and reliability; every member sees sign-up position, name, Foundry strength, and likely role, while the reliability/attendance column is officer-only;
- officer-published, version-checked lineups per session, with starter/substitute capacity enforced and each member's own selection highlighted;
- separately versioned strategy plans per session, with safe paragraphs, bullets and bold rendering plus Holder, Looter, Substitute Looter and Farmer assignments restricted to selected lineup accounts;
- versioned results per session with aggregate scores and matchup facts visible to members, while per-player points remain visible only to that player and officers;
- an officer-only legacy-event repair that adds the missing L1/L2 session and atomically assigns every existing Yes signup to it, making older separate Foundry events usable by result tooling without production scripts;
- officer-issued bot tokens that may read every normal GET route through the issuer's live groups and linked accounts, while writes remain limited to explicitly scoped guarded routes; the checked-in `state2612` skill and standard-library client support general reads, discovery, context and preview-first/idempotent writes;
- result context gives officer-issued bots an exact Player ID/name registry even when a legacy event has no published lineup, while an omitted optional points list is normalized to an empty list for aggregate-only results;
- officer-issued bots may separately receive `events:write` for preview-first, idempotent historical/current event creation and event/session metadata edits; existing session ids cannot be removed or renamed, and live issuer demotion disables the scope immediately;
- officer-issued bots may separately receive `history:write` for preview-first strength history, historic signups, attendance, lineups and tactics; aliases, relationships, membership, registrations, selections, assignments, rounded performance and evidence metadata are retained as immutable typed source records, and exact evidence bytes are SHA-256-verified in a private retained/versioned S3 bucket;
- current POP R4/R5 users may separately issue `rewards:write`; the bot can preview and idempotently register a complete screenshot-derived Fortress/Stronghold inventory batch, while live issuer rank is checked on every request and recipient assignment remains unavailable to bots;
- append-only change-history writer and account timeline;
- idempotent Foundry bundle import for accounts, measurements, events, sign-ups, and attendance, using stable `IMPORT-<id>` IDs; bundle notes are deliberately dropped because they contain internal Hermes paths that must not reach member-visible views;
- one production Foundry import: 86 game accounts and 127 strength observations, with all 47 growth rows matching Hermes' derived numbers exactly;
- AWS app/pipeline stack, production auth configuration, canary deployment, CSP/security headers, smoke tests, and cost guard.

Not implemented yet: SvS buff scheduling, screenshot extraction, reminders/outbox, access-request inbox, transfer/archive/erasure lifecycle, the general member-facing evidence registry/finalization workflow, complete exports/Athena metrics, the general-purpose agent/proposal platform, and full launch workflow.

## Domain model and invariants

### Identity

- A Cognito/login subject represents a person. A game account represents one in-game Player ID. Never merge these concepts.
- One login may link to multiple game accounts (alts); one game account may link to at most one login.
- Officers can issue either emailed-code access or an email-free temporary-password login. The production pool has an immutable email-style username schema, so email-free users receive a generated `@members.pophq.invalid` login name; it is not a real mailbox. Temporary credentials are returned once, never persisted by POP HQ, and must be replaced at first sign-in.
- Password recovery is restricted to password-based logins and R4/R5 access. It records an immutable intent before Cognito is changed, resolves the audit as completed/failed, globally signs out existing sessions, and never stores the temporary password. Officers see actor, time, justification and outcome on the member profile.
- Roster responses expose only `hasLogin` and the non-secret recovery kind, never the Cognito subject or generated login name. This drives invite/reset affordances and excludes already registered accounts from autocomplete.
- A linked current POP R4/R5 derives `officer` access on every request. This keeps invitations, promotions, demotions, and transfers in sync without waiting for Cognito token refresh; explicit Cognito `officer`/`owner` groups still work.
- All gameplay records belong to the game account, so alts retain distinct reports, answers, attendance, and history.
- Numeric Player ID is the external identity when known. Never use fuzzy name matching to invent an ID or merge accounts.
- Account statuses are `active`, `transferred_out`, `archived`, `guest`, and `unknown`. Imported history stays `unknown` unless membership is explicitly evidenced.
- Membership is an account-level evidence stream, separate from signup, registration, selection, and attendance.

### Measurements

- Reports are immutable observations; corrections create a new report with `supersedesReportId`.
- A mistaken report is never hard-deleted. `ignoredAt`, `ignoredBy`, and `ignoreReason` make it an audited soft deletion. Ignored reports remain visible in history but are excluded from current values, charts, growth, rankings, lineups, and reward calculations. Restoring removes the ignored state, while DynamoDB stream history retains both actions.
- Players may ignore/restore only player-sourced reports on their linked accounts. R4/R5 officers may moderate any member report. Every action requires a reason.
- Active-report resolution first removes ignored reports and only then applies `supersedesReportId`. Therefore, ignoring a bad correction correctly restores the report it had superseded.
- Each value has a metric, value, unit, precision, effective time, recorded time, and source.
- `city_power` and `foundry_strength`/Hermes `combat_power` are different metrics and must never be combined.
- Current value ordering is effective time, then recorded time, then record ID; superseded reports do not provide current values.
- Missing/unknown is not zero. Preserve rounded/date/unknown precision and original provenance.

### Events and attendance

- An occurrence may have sessions such as Foundry L1/L2. An account chooses at most one session; changing it replaces the prior choice.
- Member answers lock atomically at the deadline. Officers may edit until the event starts. Import code alone may call `setAnswer(..., { historic: true })` to record historical sign-ups without either time condition; the live API does not expose this escape hatch.
- Answer/commitment, in-game registration, starter/sub selection, planned assignment, actual attendance, performance, and result are distinct facts.
- Attendance is `present`, `absent`, `excused`, or `unknown`. Future expected no-shows and missing screenshots are not observed absences.
- Reliability is kept commitments over the last ten checked events. Excused and unknown records do not lower it.
- Current estimated role score is `0.7 × normalized Foundry strength + 0.3 × attendance rate`; unknown attendance counts as reliable. It remains an estimate until officers publish a lineup.
- A Foundry legion defaults to 30 starters and 10 substitutes. Capacity belongs to the session and is editable per event through `EventSession.starters`/`subs`; substitutes are not “free starter spaces.”
- A published lineup is versioned per session. Strategy is a separate versioned record: assignments may only name accounts selected in that session's published lineup, while a plan without assignments may be drafted before the lineup exists.

### History and writes

- Current items carry actor/source metadata. History is append-only and must preserve before/after, changed fields, effective time, and provenance.
- Concurrency-sensitive rules belong in the same DynamoDB transaction/condition as the write: unique links/IDs, answer deadline, account status, seats, and eventually capacities/buff slots.
- Agent changes default to dry-run and large/sensitive changes become officer-approved proposals. Blind restoration is not an acceptable revert strategy.

## Lambda bundling

Every Lambda must use the shared `NODE_BUNDLING` options from `infra/lib/node-bundling.ts`: ESM output, target `node24`, `mainFields: ["module", "main"]`, no external AWS SDK, and the `createRequire` banner. Without the banner, a bundle can deploy successfully but die at startup with `Dynamic require of node:https is not supported`.

`infra/test/bundles.test.ts` guards this production failure mode by synthesizing into a fresh temporary directory and starting every generated Lambda bundle in a plain Node process. Do not replace that with a Vitest-hosted import: Vitest's loader supplies `require`, which masks the exact startup failure being tested.

## Non-negotiable repository rules

- Never put secrets in code or commits. Gitleaks runs in the pre-commit hook and CI.
- Never commit the Foundry bundle or real member data to this public repository. Tests use invented names and `7xxxxxxxx` Player IDs.
- Never reference or link unrelated private projects from this repository.
- Develop and debug locally with unit tests first; run integration tests for anything in the deploy path.
- cdk-nag is v3: acknowledge findings with `Validations.of(scope).acknowledge(...)` using each complete finding ID. Aspects/validation plugins do not cross a `Stage` boundary, so each stage registers its own plugin.

## Foundry fixture guidance

The private fixture contains 102 stable game-account UUIDs, 86 numeric Player-ID crosswalks, 149 typed strength observations, 60 current 20 September sign-ups, 183 planned assignments, actual attendance only for 6 September, and 19 hash-verified evidence records.

Use `foundry-data.json` or the smaller normalized JSON files, not both normalized data and raw SQLite as separate imports. Preserve supplied IDs and import in dependency order. Repeated imports must be idempotent. Quarantine missing numeric IDs and mapping conflicts. Do not:

- treat stable UUIDs as authentication users;
- merge alts or fuzzy-match names;
- convert unknown 20 September attendance into absence/zero;
- treat `expected_no_show` as an actual absence;
- relabel combat score as city power;
- replay old proposals/strategies as current state;
- infer active membership from an old snapshot or legacy active flag;
- import excluded birthday/social information.

## Feature-work checklist

Before implementing a feature:

1. Find its `P*` item in `docs/PLAN.md` and the matching story/requirement IDs in the handoff spec.
2. Check the compatibility review for a correction to the original model.
3. Inspect existing domain code and tests before adding routes or UI.
4. Keep domain rules pure where possible; keep persistence conditions transactional.
5. Add unit tests for rules, integration tests for data/auth/concurrency, and UI tests for helpers/state.
6. Run locally first using `docs/LOCAL_DEBUGGING.md`.
7. Do not deploy, retire Cloudflare, migrate live data, or contact players unless explicitly authorized.

## Known product questions

Still unresolved or only partly resolved: exact owner/deputy model, Discord login policy for officers, final visual direction, troop totals versus tiers, screenshot frequency/retention, authoritative buff-day overrides, external event source, per-person versus per-game-account SvS slot allocation, and whether tactical learning lives fully in POP HQ or coexists with Hermes.
