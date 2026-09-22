---
name: state2612
description: Read POP HQ information available to the bot token's issuing user, and safely preview or apply event maintenance, results, Fortress rewards, historical backfills, and evidence. Use for POP HQ questions, screenshot reward registration, historical event setup, roster-history imports, corrections, and scoreboard data; undocumented writes remain forbidden.
---

# POP HQ bot access

Use `scripts/s26.py` for POP HQ API calls. It uses only Python's standard library and reads:

- `POPHQ_URL`: the POP HQ base URL, such as `https://example.cloudfront.net`.
- `POPHQ_BOT_TOKEN`: the one-time `s26_...` credential issued by an officer.

Never print, persist, or place the token in a command argument. Run `doctor` before work. Read [references/read-api.md](references/read-api.md) when retrieving general POP HQ data, [references/events-api.md](references/events-api.md) before creating or editing events, [references/results-api.md](references/results-api.md) before preparing a result, [references/rewards-api.md](references/rewards-api.md) before extracting or registering Fortress/Stronghold rewards, and [references/history-api.md](references/history-api.md) before importing historical records or evidence.

## Reading POP HQ

The token may call normal `GET /v1/...` routes with exactly the issuer's current groups and linked accounts. Use `get` for general reads. Use `--account-id` only with a Player ID linked to the issuer when a personalized view is needed. The server rejects every normal write route even if the issuer is an officer.

## Result workflow

1. Run `list-events --kind foundry` to discover event and session IDs. Match the requested date, time and session label exactly; ask the officer if more than one item could match.
2. Fetch `result-context` for that exact event and session. `lineup` is the officer-confirmed participant list when one was published; `players` is the permitted exact Player ID/name registry for legacy events without a lineup. Use only returned Player IDs, and only attach points when the scoreboard name matches exactly. Names must never be fuzzy-matched.
3. Preserve missing facts as omitted fields. Never turn an unreadable or absent value into zero.
   A confirmed positive scoreboard row is also attendance evidence: for historical backfills,
   preview a matching `present` attendance record for that player and event. A zero score or a
   missing row never proves presence or absence.
4. Write a JSON payload with the current result's `version` as `expectedVersion`, or `0` when no result exists.
5. Preview first. Present the returned before/after diff to the officer.
6. Apply only after the officer explicitly approves that exact diff. Supply a meaningful reason and a stable idempotency key. Retrying the exact approved request with the same key is safe; never reuse the key for changed data.
7. Stop on validation, conflict, expired-token, or unknown-player errors. Do not guess a replacement ID, silently drop a row, or bypass a stale version.

Typical commands:

```bash
python3 scripts/s26.py doctor
python3 scripts/s26.py get /events
python3 scripts/s26.py get /roster
python3 scripts/s26.py list-events --kind foundry
python3 scripts/s26.py result-context EVENT_ID SESSION_ID
python3 scripts/s26.py put-result EVENT_ID SESSION_ID result.json
python3 scripts/s26.py put-result EVENT_ID SESSION_ID result.json --apply --reason "Reviewed scoreboard" --idempotency-key EVENT_ID-SESSION_ID-v1
```

The API defaults guarded writes to dry-run even if the CLI is used incorrectly. `--apply` is intentionally separate from preview. Normal web write routes and every undocumented write family remain forbidden.

## Event workflow

With `events:write`, an officer-issued bot may create events (including historical ones) and edit event/session metadata. Preview every exact change first, then apply only after an officer approves that diff. Creation requires a stable caller-selected event id. Editing cannot remove or rename existing session ids because dependent records use them as foreign keys. Follow [references/events-api.md](references/events-api.md) for payloads, preview hashes and commands.

## Fortress reward workflow

With `rewards:write`, a bot issued by a current POP R4/R5 may register the structured inventory visible in Fortress or Stronghold reward screenshots. Keep Fortress and Stronghold hero shards separate, preserve uncertainty instead of guessing, preview the entire batch, and apply only after an officer approves that exact diff. This scope cannot distribute inventory to members. Follow [references/rewards-api.md](references/rewards-api.md) for the supported keys, payload and commands.

## Historical backfill workflow

With `history:write`, import exact records one at a time so a package can resume at a precise source row. Live models cover typed measurements, signups, attendance, lineups and tactics. Immutable preserved records cover aliases, account relationships, membership, registrations, selections, assignments, rounded performance and evidence metadata; evidence bytes are hash-verified and privately stored. Preview and review every record before apply. Follow [references/history-api.md](references/history-api.md), retain a local applied/quarantined manifest, and never guess missing website IDs.
