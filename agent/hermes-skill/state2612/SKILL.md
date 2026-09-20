---
name: state2612
description: Read POP HQ Foundry result context and safely preview or apply event results and per-player scores through the scoped agent API. Use for POP HQ result imports, corrections, and scoreboard data; do not use for general roster or administrative changes.
---

# POP HQ results

Use `scripts/s26.py` for POP HQ API calls. It uses only Python's standard library and reads:

- `POPHQ_URL`: the POP HQ base URL, such as `https://example.cloudfront.net`.
- `POPHQ_AGENT_TOKEN`: the one-time `s26_...` credential issued by an officer.

Never print, persist, or place the token in a command argument. Run `doctor` before work. Read [references/results-api.md](references/results-api.md) before preparing a result.

## Result workflow

1. Fetch `result-context` for the exact event and session. Use only returned Player IDs; names are display aids and must never be fuzzy-matched.
2. Preserve missing facts as omitted fields. Never turn an unreadable or absent value into zero.
3. Write a JSON payload with the current result's `version` as `expectedVersion`, or `0` when no result exists.
4. Preview first. Present the returned before/after diff to the officer.
5. Apply only after the officer explicitly approves that exact diff. Supply a meaningful reason and a stable idempotency key. Retrying the exact approved request with the same key is safe; never reuse the key for changed data.
6. Stop on validation, conflict, expired-token, or unknown-player errors. Do not guess a replacement ID, silently drop a row, or bypass a stale version.

Typical commands:

```bash
python3 scripts/s26.py doctor
python3 scripts/s26.py result-context EVENT_ID SESSION_ID
python3 scripts/s26.py put-result EVENT_ID SESSION_ID result.json
python3 scripts/s26.py put-result EVENT_ID SESSION_ID result.json --apply --reason "Reviewed scoreboard" --idempotency-key EVENT_ID-SESSION_ID-v1
```

The API defaults to dry-run even if the CLI is used incorrectly. `--apply` is intentionally separate from preview.
