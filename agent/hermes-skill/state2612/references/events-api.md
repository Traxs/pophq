# Events API

Event metadata writes require `events:write`; named registration writes require the separate `registrations:write` permission. The issuing user must currently be an officer or owner. They use guarded bot routes, never the normal web write routes. Browser-origin bot requests are rejected.

Supported built-in `kind` values are `foundry`, `svs`, `koi`, `fdt`, `canyon`, `tundra`, `bear`, and `other`. KOI uses `koi` and normally has the same `full`, `first`, and `last` sessions as SvS, but it is a separate state-internal event.

SvS and KOI answers close three hours before start by default. An event may override the cutoff with either `answersCloseHoursBefore` or `answersCloseDaysBefore`, never both. Omitting `sessions` creates a simple RSVP; the standard availability choice uses session ids `full`, `first`, and `last`.

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
- `events:write` does not write accounts, measurements, answers, attendance, lineups, strategies, results, relationships or evidence. Approved historical backfills use the separate `history:write` routes.

## Register named players for an existing event

`PUT /v1/agent/events/{eventId}/registrations`

This guarded batch operation requires `registrations:write`. It updates only the Player IDs present in `registrations`; every omitted answer is preserved. Each Player ID must already exist in the event alliance, remain writable, and be sent exactly once. Each session must already exist on the event. The event must not have started.

```json
{
  "registrations": [
    { "playerId": "414051721", "answer": "yes", "sessionId": "L1", "role": "substitute" },
    { "playerId": "402574597", "answer": "yes", "sessionId": "L1" },
    { "playerId": "401250554", "answer": "yes", "sessionId": "L2" }
  ]
}
```

Field semantics:

- `answer` is required and must be exactly `yes`. Withdrawals and attendance corrections are outside this operation.
- `sessionId` is required and identifies the existing Legion or event part.
- `role` is optional. Its only supported value is `substitute`, and it means an officer explicitly supplied that designation.
- An omitted `role` is deliberately **unspecified**. It never means starter. Capacity-based “likely starter/sub” remains only a UI estimate until a lineup is published.
- Registration is planning data. It does not create attendance evidence, a result, or a published lineup.

Preview:

```bash
python3 scripts/s26.py put-registrations EVENT_ID registrations.json
```

The response returns the event/session state, an exhaustive before/after row for every named Player ID, and `expectedHash`. Review the exact diff with the officer. Apply only after approval:

```bash
python3 scripts/s26.py put-registrations EVENT_ID registrations.json \
  --apply \
  --expected-hash HASH_FROM_PREVIEW \
  --reason "Owner approved the supplied Foundry registration list" \
  --idempotency-key EVENT_ID-registrations-v1
```

Apply adds `approved: true` and uses `?apply=true`. The server rejects a stale preview if the event or any named registration changed, commits all changed rows and the idempotency receipt atomically, attributes the audit record to the bot token and reason, and performs exact readback. An identical retry with the same idempotency key returns `replayed: true`; reusing the key for another body is rejected.

Read back through the normal API:

```bash
python3 scripts/s26.py get /events/EVENT_ID
```

The session's `signedUpList` and officer `members` rows contain `registrationRole: "substitute"` when explicitly saved. The event UI shows “Substitute · officer”; rows without it continue to show only the estimated likely role.
