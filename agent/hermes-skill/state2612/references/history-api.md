# Historical import API

Historical writes require `history:write` and an issuing user who is currently an officer or owner. Existing tokens do not gain this scope. Every route below defaults to preview and returns `expectedHash`; apply requires the reviewed hash, a reason and a unique idempotency key.

Use exact website Player IDs and event/session IDs discovered through POP HQ. Never fuzzy-match a name, invent a Player ID, convert missing attendance to absence, or promote rounded scores to exact scores. Quarantine unmapped rows in the local import report.

## Live POP HQ records

Use `put-history PATH payload.json` with one of these paths:

| Data | Path | Required payload fields |
|---|---|---|
| Typed measurement | `/agent/history/reports/{playerId}/{stableReportId}` | `effectiveAt`, `recordedAt`, `values[]`; each value has `metric`, `value`, `precision` |
| Signup/withdrawal | `/agent/history/events/{eventId}/signups/{playerId}` | `answer`, `answeredAt`; a `yes` answer also has `sessionId` |
| Attendance | `/agent/history/events/{eventId}/attendance/{playerId}` | `status`, `recordedAt`; optional `sessionId`, `source`, `note`, `evidenceRef` |
| Starter/sub lineup | `/agent/history/events/{eventId}/sessions/{sessionId}/lineup` | `entries[]`, `publishedAt`, `expectedVersion`; entries contain exact `playerId` and `starter` or `sub` role |
| Tactics | `/agent/history/events/{eventId}/sessions/{sessionId}/strategy` | `body`, `assignments[]`, `publishedAt`, `expectedVersion`; assignments must refer to the published lineup |

Use `foundry_strength` for Hermes `combat_power`; it is never `city_power`. Precision is `exact`, `rounded`, `date`, or `unknown`. Report IDs are stable and immutable, so repeating a source observation cannot create another report.

Preview and apply one record:

```bash
python3 scripts/s26.py put-history /agent/history/reports/PLAYER_ID/IMPORT-SOURCE_ID report.json
python3 scripts/s26.py put-history /agent/history/reports/PLAYER_ID/IMPORT-SOURCE_ID report.json \
  --apply --expected-hash HASH_FROM_PREVIEW --reason "Approved historical backfill" \
  --idempotency-key history-report-SOURCE_ID
```

Import lineups before tactics with assignments. Preserve actual attendance separately from signup, registration, selection, expected no-show and performance.

When a reviewed scoreboard visibly identifies a player with a positive score, preview a
`present` attendance record for the same event (and session when known). Do this even when the
displayed score is rounded and therefore belongs only in preserved `performance` data rather
than exact result points. Never infer `absent` from zero, an omitted row, an incomplete ranking,
or an unreadable name.

## Preserved source facts

Facts without a richer current product view are stored immutably rather than squeezed into notes. Put one record at `/agent/history/{stableRecordId}` with:

```json
{
  "category": "alias",
  "sourceId": "source-row-id",
  "playerId": "700000001",
  "occurredAt": "2026-09-01T00:00:00Z",
  "reviewStatus": "verified",
  "confidence": 1,
  "payload": { "name": "prior exact name", "source_refs": ["bundle/path"] }
}
```

Categories are `alias`, `relationship`, `membership`, `registration`, `selection`, `assignment`, `performance`, and `evidence`. Keep the original typed payload and provenance. A relationship record describes primary/alternate evidence; it never merges the accounts. Performance preserves its original unit and precision, so rounded observations stay distinct from exact result points. Read records with `list-history CATEGORY`.

## Evidence files

First preserve the evidence metadata as an `evidence` historical record. Then upload its exact private file to `/agent/history/evidence/{stableRecordId}/content` using a JSON payload containing:

```json
{
  "contentBase64": "...",
  "contentType": "image/jpeg",
  "sha256": "64 lowercase hexadecimal characters"
}
```

Accepted types are JPEG, PNG, WebP, PDF, JSON and plain text; the limit is 5 MB per object. The server recomputes SHA-256, stores the object in a private retained/versioned bucket, and refuses overwrite. `GET /v1/agent/history/evidence/{recordId}/content` returns the original bytes to a bot with read access.

## Safeguards

- Preview never writes. Apply needs `?apply=true`, the preview hash, a reason, and an 8–100 character idempotency key.
- Losing officer/owner status disables the scope immediately.
- A stale preview or conflicting stable ID stops the import. Do not mutate the source to make it pass.
- Apply one source record at a time. This makes large backfills resumable and gives every failure an exact row.
- Existing exact-score routes remain the only place for confirmed result points. Rows without a confirmed website Player ID remain quarantined.
