# Events API

Event writes require `events:write` and an issuing user who is currently an officer or owner. They use guarded bot routes, never the normal web write routes. Browser-origin bot requests are rejected.

## Create an event

`POST /v1/agent/events`

The payload includes a stable `eventId` of 3–80 letters, digits, `_` or `-`, plus normal event fields. Historical start times are allowed. Session ids must be stable and unique.

```json
{
  "eventId": "HISTORY-2026-09-06-L2",
  "kind": "foundry",
  "title": "Foundry — September 6 L2",
  "startsAt": "2026-09-06T19:00:00.000Z",
  "deadlineAt": "2026-09-06T18:00:00.000Z",
  "sessions": [
    { "id": "L2", "label": "Legion 2", "startsAt": "2026-09-06T19:00:00.000Z", "starters": 30, "subs": 10 }
  ]
}
```

Preview and apply:

```bash
python3 scripts/s26.py create-event event.json
python3 scripts/s26.py create-event event.json --apply --reason "Approved historical event" --idempotency-key history-20260906-l2
```

## Edit an event

`PATCH /v1/agent/events/{eventId}`

Send only changed event fields. To edit sessions, send the complete desired session list. Existing session ids cannot be removed or renamed; labels, times and capacity may change, and new sessions may be added.

The preview returns `expectedHash`. Applying requires that exact hash, so a concurrent change forces a new preview:

```bash
python3 scripts/s26.py edit-event EVENT_ID edit.json
python3 scripts/s26.py edit-event EVENT_ID edit.json --apply --expected-hash HASH_FROM_PREVIEW --reason "Approved correction" --idempotency-key event-edit-unique-key
```

## Shared safeguards

- Preview is the default and never writes.
- Apply requires `?apply=true`, a meaningful reason, and an `Idempotency-Key` of 8–100 safe characters.
- Retrying the identical approved apply with the same key returns the original success. Never reuse a key for different data.
- Event creation conflicts with an existing id. Event editing conflicts if the event changed after preview.
- Losing officer/owner status disables the write scope immediately.
- This scope does not write accounts, measurements, answers, attendance, lineups, strategies, results, relationships or evidence.
