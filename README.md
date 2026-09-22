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
| `agent/hermes-skill/` | Result-import skill and the `s26` CLI |
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

Roles are Cognito groups defined in the stack: `player` (every signed-in person), `officer` (roster and planning tools) and `owner` (runs the site). R1–R5 is stored on the game account. A linked current POP R4/R5 automatically receives officer access from that rank, so inviting or promoting an R4 does not require a separate Cognito-group operation; explicit `officer` and `owner` groups remain valid for bootstrap and exceptional access.

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

Officers invite from the Members page and choose either **Email code** or **Create password**. Email-code access uses the member's email and sends a one-time code whenever they sign in. Password access creates a pseudonymous login name plus a temporary password, shows both to the officer exactly once, and requires the member to sign in within Cognito's seven-day window and choose a private password; no personal email is required, so an officer must verify the member if access later needs to be recovered. The form can find existing unregistered roster members by name or Player ID and fills their known details. An unregistered member's detail page offers the same form already filled in.

One step creates the Cognito login, creates the game account when necessary, and links the two; repeating the same invite does not expose credentials or create another login. A linked current POP R4/R5 can immediately open officer-only pages, even when their existing token predates the invite or promotion. Logins are capped at 100 seats (FM-08); alts of the same person do not use extra seats.

For password-based access, R4/R5 users can open the member profile and choose **Reset password**. They must record a 5–200 character verification reason. POP HQ records the request before touching Cognito, sets a new seven-day temporary password, revokes the member's existing Cognito sessions, and records whether the operation completed or failed. The one-time password is never stored in POP HQ or its audit history. The member profile's **Access security** section shows the actor, time, reason, and outcome of every attempt for fraud review. Email-code accounts do not offer password reset.

Locally the invite flow uses a stand-in directory in DynamoDB Local. It demonstrates and tests issuance, autocomplete, linkage, password resets, and access-audit history, but newly invited email/password logins cannot authenticate against the mock OIDC picker; the test personas cover signed-in flows.

**Troops** are reported per type. Infantry, Lancer and Marksman each have their own FC level — capped by the furnace, since troops cannot pass it — and **Helios** is an upgrade on top of a type's level, so a member can hold it on all three at once. A report states both the level and whether Helios is there, so turning it off is as recordable as turning it on.

Officers keep the roster right from the Members table itself: **rank** and **membership** are inline, so fixing a hundred imported accounts does not mean a hundred forms. A rename moves the account's entry in the roster index with it, an officer's note can be attached to anyone, and every change is recorded with who made it. Marking somebody as having left stops new data reaching their account; making somebody a guest is done together with their alliance, since a guest belongs to another one.

## Events

Officers schedule events (Foundry, SvS, FDT, Canyon, Tundra League, other) with a start time. Answers close a set number of days before the start, per type: **Foundry three days**, because officers register the participants in game afterwards; other types an hour before unless changed. The deadline falls at the end of that day in the officer's time zone, and can be overridden per event. Officers can edit an event later; moving the start moves the deadline with it. Event types are defined by officers: each carries how many days before the start answers close, which parts people choose between, and a strategy template. New events inherit from a type and can still be changed.

Reliability is **participation**, not just attendance. Each past event is one of four things: they **attended** (full credit), they **signed up and did not come** (zero, counted double — the alliance planned a slot around them), they **never answered** (zero at half weight: disengagement rather than a broken promise), or it does not count at all (excused, nobody checked, or an honest "can't make it"). Saying "I can't make it" is engagement and never costs anything. An account is not judged on events from before POP HQ knew it existed, unless there is real evidence — so an imported roster keeps its imported attendance without being blamed for silence it predates.

After an event, officers mark who turned up (present, absent, excused, or left unknown when nobody checked). Reliability is the share of kept commitments over the last ten **checked** events: an excused absence or an event nobody checked never lowers it, so a missing screenshot cannot cost a member their spot.

Who starts and who substitutes is estimated as **0.7 × (Foundry strength ÷ strongest signed up) + 0.3 × attendance rate**, with unknown attendance counted as reliable; officers publish the real lineup, which then replaces the estimate everywhere. Members see the sign-up table with strength and likely role; the reliability score is officer-only. After the deadline members can no longer change their answer, but officers keep editing who is coming until the event starts.

Tables carry small six-month graphs: **Strength 6m** is the Foundry strength at the end of each month (a level, carried forward when nothing was reported), and **Attendance 6m** is a trailing average — each month averaged with the two before it — on a fixed 0–100% scale with a faint halfway mark, green above half and red below. One bad night therefore bends the line instead of dropping it to the floor. A month with nothing recorded is a gap, never a zero, and a single reading shows as a dot rather than a fake trend.

Opening an event shows each part with its capacity (a Foundry legion takes 30 starters and 10 substitutes, set per event), how full it is, who signed up, and — until officers publish the lineup — an estimate of your role ranked by Foundry strength, clearly marked as an estimate. Officers additionally see a table of every member with their answer, legion, Foundry strength, power, furnace and last report, with totals per legion.

After publishing a lineup, officers publish a separate strategy for each part: a short plan plus Holder, Looter, Substitute Looter and Farmer assignments. Everyone sees the plan and assignment table, with their own row highlighted. Strategy edits are version-checked, so one officer cannot silently overwrite another officer's newer plan.

After a part starts, officers record its result: victory, defeat or draw; both scores; optional matchmaking-power totals, opponent count and notes; and optional points per player. Aggregate results are visible to every member. Individual points are visible only to that player and officers. Corrections are version-checked and the previous value remains in change history.

Mistaken power or strength reports can be **ignored** instead of erased. A player can ignore and restore reports they submitted for their own linked account; an R4/R5 can do the same for any member report. A reason is mandatory. Ignored entries remain visibly marked in report history and in the append-only audit trail, but stop contributing to current values, graphs, growth, rankings and reward calculations. If an ignored entry was itself a correction, its predecessor becomes active again.

**Publishing a lineup** turns that estimate into a decision. An officer opens the part, sets each person to Starting, Substitute or Not playing — the list opens on the published lineup, or on the estimate when there is none — and publishes. Everyone then sees the lineup with their own row highlighted, and their pill changes from "Likely starting" to "You're starting · #4"; the capacity bar counts the lineup rather than the sign-ups. Each publish is a new version, kept in the change history like any other write. Publishing sends the version that was edited, so a second officer working from a stale page is told to reload instead of overwriting the first. Capacity is enforced in the write, and someone picked although they never answered is shown as "didn't answer" rather than hidden.

**SvS and FDT** ask how much of the event someone can give rather than which slot they take: **Full time**, **First half** or **Last half**, plus "can't make it". That is the same mechanism as the Foundry legions — three parts, one pick.

**Canyon and Tundra League** are a plain "are you in?": one button to join, and the same button to drop out again. No maybe, because an officer cannot plan on a maybe.

The **Bear hunt** is not a sign-up event. It runs every other day and needs no organising, so its type is archived; events recorded against it before still read correctly.

A Foundry is **one event with two legions**: members pick Legion 1, Legion 2 or Not signed up, never both, and switching legions replaces the earlier pick. Historical imports that represented same-day L1 and L2 as separate events are collapsed into one participation opportunity, so choosing L2 never creates an unanswered-L1 penalty. Other events keep the plain Yes / Maybe / No. Members answer per game account, so someone with alts answers once per account, and may change their mind until the deadline. The deadline is checked in the same write as the answer, so a late answer cannot slip through (FM-09). Officers see counts and the lists behind them, including who has not answered, and may answer on someone's behalf.

## SvS buff slots

An officer opens a round for an SvS week: Construction, Research and Training, which default to that week's Monday, Tuesday and Thursday and can be changed per round. Each buff day is 48 half-hour slots from 00:00 UTC.

While the round is collecting, every member picks **up to three times per day, best first**, or answers "any time works" or "can't this day" — three different answers, and none of them is the same as staying silent. Times are shown in the reader's own time zone, with a **+1** marker on slots that fall on the next local day, so nobody picks Tuesday 01:00 thinking of Monday. The number of people wanting each slot is visible while choosing, so anyone flexible can aim for a quiet hour. Preferences close at the deadline, checked in the same write as the save (FM-09).

Officers then assign. Who gets a contested slot is a formula, not a hunch: **0.6 × attendance rate + 0.2 × (Foundry strength ÷ strongest) + 0.2 × kudos share**, with a first choice beating a second choice before the score is consulted. Unknown attendance counts as reliable, so missing data never costs someone their place. One slot per person per buff day and at most two across the round — the cap is per person, so alts do not multiply someone's share.

## Fortress and Stronghold rewards

Fortress and Stronghold takeover rewards are tracked separately from scheduled SvS ministry slots. An R4 or R5 registers a complete haul in one form using recognizable game icons and one-tap presets: allocatable chests, speedups, Health, Damage and Deployment Capacity buffs, Fortress and Stronghold hero shards, Advanced Teleporters, Stronghold materials/components and Fire Crystals. Quantities remain editable because the won forts and current game phase can differ.

POP HQ ranks active members using the same 60% participation, 20% Foundry-strength and 20% kudos formula. Members can see who is currently eligible; officers also see the calculation behind each position. Officers can split a pool into different quantities for several eligible recipients. Every allocation is recorded permanently and decrements the remaining inventory atomically.

Each takeover registration has a durable batch identity. R4/R5 users get separate **Available inventory** and **Distribution history** views; history groups the complete haul by cycle and shows every reward's original quantity, remaining stock, recipient, amount and assignment time. Older pools created before batch identities are reconstructed from their shared source, acquisition timestamp and creator.

When an officer assigns a reward, POP HQ also freezes the eligibility decision: position, total score, participation, Foundry strength relative to the strongest account, kudos share and the weights used. The recipient sees the reward on Home with an expandable **Why you received this reward** explanation. These private inputs are visible only to that recipient and R4/R5 users; later reports or participation changes do not rewrite the historical reason.

Every active member sees a private **Fortress reward eligibility** card on Home: eligible or waiting, their live place and cutoff, the overall score, and the exact participation, Foundry-strength and Kudos arithmetic behind it. It also shows the live decayed Kudos total, the original and current value of every award or correction, its officer-written reason, percentage and days remaining, and expired history. Eligibility permits an R4 selection while inventory exists; it does not promise an assignment.

Once an R4 makes an assignment from the newest registered takeover cycle, Home shows it separately as **Coming to you**, including the game icon, exact amount, confirmation time, and the frozen eligibility explanation. Older cycles remain history and are never mislabeled as upcoming.

**Kudos** are what the numbers cannot see: an officer awards points with a reason, and each award decreases linearly to zero over 90 days so the score reflects who is contributing now. Awards are immutable; taking points back is its own award, and both stay in the history.

**Running an event** is a checklist. Each type carries its jobs — a Foundry runs from "post the sign-up call" through registering people, publishing the lineup and setting deployments, to recording who turned up — and every job hangs off one of the event's own moments rather than a fixed date, so moving the event moves the whole list. An event names the officer who runs it, and Home shows each officer what is still to do: their own events first, then anyone else's, with anything a day late in red. Any officer can tick a job off and the tick records who did it. A job whose chance has gone — a lineup for a battle already fought — stops appearing on Home and stays on the event page.

## Importing a Hermes bundle

```bash
npm run import:foundry -w api -- --bundle /path/to/foundry            # dry run: prints the plan
npm run import:foundry -w api -- --bundle /path/to/foundry --apply    # writes to the local table
npm run import:foundry -w api -- --bundle /path/to/foundry --apply --aws   # writes to the PopHq stack
```

## Bot result access

Officers can issue a dedicated credential from **Members → Bot tokens**. The secret is shown once. A bot may read everything its issuing user can currently read; normal write routes remain forbidden. Optional scopes cover preview-first Foundry results, event maintenance, historical imports and Fortress reward registration. `rewards:write` is available only to a current POP R4/R5 and registers inventory without assigning recipients. Every request re-checks the issuing person's current Cognito groups and linked accounts, so demotion immediately reduces the bot's access and account removal disables it.

The checked-in skill is [`agent/hermes-skill/state2612`](agent/hermes-skill/state2612/SKILL.md). Give that folder to the bot and set `POPHQ_URL` plus the issued `POPHQ_BOT_TOKEN` in its environment. From the repository root, the included standard-library client starts with:

```bash
python3 agent/hermes-skill/state2612/scripts/s26.py doctor
python3 agent/hermes-skill/state2612/scripts/s26.py get /events
python3 agent/hermes-skill/state2612/scripts/s26.py get /roster
python3 agent/hermes-skill/state2612/scripts/s26.py list-events --kind foundry
python3 agent/hermes-skill/state2612/scripts/s26.py result-context EVENT_ID SESSION_ID
python3 agent/hermes-skill/state2612/scripts/s26.py put-result EVENT_ID SESSION_ID result.json
```

If your shell is in the directory above this repository (for example `~/workspace/WOS`), first run `cd pophq`, or prefix those paths with `pophq/`.

Result writes are previews by default. Applying requires `--apply`, a reason, and a stable idempotency key; all other normal write routes reject bot tokens. Bot tokens are refused from browsers, expire within 90 days and after 30 unused days, and an officer can revoke them from the same screen.

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
