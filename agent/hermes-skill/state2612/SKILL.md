---
name: state2612
description: Read all POP HQ information available to the bot token's issuing user, and safely preview or apply event results and per-player scores. Use for POP HQ questions, analysis, result imports, corrections, and scoreboard data; writes other than scoped result updates are forbidden.
---

# POP HQ bot access

Use `scripts/s26.py` for POP HQ API calls. It uses only Python's standard library and reads:

- `POPHQ_URL`: the POP HQ base URL, such as `https://example.cloudfront.net`.
- `POPHQ_BOT_TOKEN`: the one-time `s26_...` credential issued by an officer.

Never print, persist, or place the token in a command argument. Run `doctor` before work. Read [references/read-api.md](references/read-api.md) when retrieving general POP HQ data, and [references/results-api.md](references/results-api.md) before preparing a result.

## Reading POP HQ

The token may call normal `GET /v1/...` routes with exactly the issuer's current groups and linked accounts. Use `get` for general reads. Use `--account-id` only with a Player ID linked to the issuer when a personalized view is needed. The server rejects every normal write route even if the issuer is an officer.

## Result workflow

1. Run `list-events --kind foundry` to discover event and session IDs. Match the requested date, time and session label exactly; ask the officer if more than one item could match.
2. Fetch `result-context` for that exact event and session. Use only returned Player IDs; names are display aids and must never be fuzzy-matched.
3. Preserve missing facts as omitted fields. Never turn an unreadable or absent value into zero.
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

The API defaults result writes to dry-run even if the CLI is used incorrectly. `--apply` is intentionally separate from preview. No other write family is available to bot tokens.
