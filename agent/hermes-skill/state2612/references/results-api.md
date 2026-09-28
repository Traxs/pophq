# Results API

All requests use `Authorization: Bearer $POPHQ_BOT_TOKEN`. Bot tokens are refused when an `Origin` header is present.

## Discover events

`GET /v1/agent/events`

Returns only event IDs, kinds, titles, start times, and session IDs/labels/start times. It deliberately excludes sign-ups, notes, accounts and officer data. By default it includes events starting in the last seven days or later, up to 50 events ordered earliest first.

Optional query parameters:

- `kind`: `foundry`, `svs`, `koi`, `fdt`, `canyon`, `tundra`, `bear`, or `other`. `koi` is the monthly state-internal King of Icefield event; it remains distinct from cross-state SvS.
- `from`: an ISO date or timestamp for older or narrower discovery.

## Read context

`GET /v1/agent/events/{eventId}/sessions/{sessionId}/result-context`

Returns the event, session, published lineup with numeric Player IDs and names, the permitted `players` registry, and the current result or `null`. `lineup` may be empty for a legacy event; this does not prevent aggregate results. Use `players` for exact Player ID/name mapping, but do not treat every registry entry as a participant.

## Preview or apply a result

`PUT /v1/agent/events/{eventId}/sessions/{sessionId}/result`

Without `?apply=true`, the response is an exact `before`/`after` diff and no data changes.
It also returns `expectedHash`; apply must echo that reviewed hash.

Payload:

```json
{
  "outcome": "win",
  "ourScore": 1240,
  "opponentScore": 980,
  "ourMatchmakingPower": 2430000000,
  "opponentMatchmakingPower": 2510000000,
  "opponentCombatants": 28,
  "notes": "Optional reviewed note",
  "playerPoints": [
    { "playerId": "700000001", "points": 52400 }
  ],
  "expectedVersion": 0
}
```

Rules:

- `outcome`: `win`, `loss`, or `draw`.
- Scores and points are non-negative integers. Player IDs are numeric strings.
- Matchmaking power, opponent count, notes, and player points are optional facts. Omit unknown values.
- Omitting `playerPoints` records an aggregate/team-only result; it is normalized to an empty list.
- Each Player ID appears at most once and must already exist in POP HQ.
- `role` is `starter` or `substitute` and belongs only on POP player rows. If it is omitted but a
  published POP lineup already knows the role, the server stores that known role automatically.
- A positive player-points row is treated as participation evidence throughout POP HQ. Zero
  points are an explicit registered no-show, including for a substitute. Omitted players remain
  unknown.
- Results can only be recorded after that session starts.
- Use the current version returned by context. A stale version is rejected.
- Apply additionally requires `approved: true`, the preview's `expectedHash`, a meaningful
  `reason`, query `apply=true`, and an `Idempotency-Key` header of 8–100 safe characters.
- The same key and exact payload replay the first success. The same key with different data returns a conflict.

Individual points are returned to officers and the affected player in the web app, not to other members.

### Canyon Clash: three alliance totals

Canyon stores the three official alliance battle totals independently. They are not calculated
from POP player points. Opponent player scores, roles and attendance are unavailable and must be
omitted. Use `allianceScores` instead of the legacy pair:

```json
{
  "outcome": "win",
  "allianceScores": [
    { "allianceTag": "POP", "allianceName": "POP", "isOurAlliance": true, "score": 550591, "precision": { "kind": "exact" } },
    { "allianceTag": "BOS", "allianceName": "S", "isOurAlliance": false, "score": 487805, "precision": { "kind": "exact" } },
    { "allianceTag": "SOA", "allianceName": "SonsOfAnarchy", "isOurAlliance": false, "score": 486816, "precision": { "kind": "exact" } }
  ],
  "playerPoints": [
    { "playerId": "700000001", "points": 515000, "role": "starter",
      "precision": { "kind": "rounded", "display": "515.0K", "roundedTo": 100 } },
    { "playerId": "700000002", "points": 0, "role": "substitute" }
  ],
  "expectedVersion": 0
}
```

A rounded source display must remain visibly rounded:

```json
{ "allianceTag": "POP", "allianceName": "POP", "isOurAlliance": true, "score": 515000,
  "precision": { "kind": "rounded", "display": "515.0K", "roundedTo": 100 } }
```

The numeric `score` supports ordering; the UI renders `≈ 515.0K`, never `515,000` as an exact
claim. Exactly one row is ours, all tags must be unique, Canyon requires exactly three rows, and
`outcome` must agree with the highest total (or a tied highest total for `draw`). The response
retains `ourScore` and `opponentScore` as a compatibility projection for old readers, but
`allianceScores` is authoritative.

The same optional `precision` object is valid on a POP `playerPoints` row. Its `points` value is
the numeric representative used for ordering, while every player-facing score view preserves
the source as `≈ 515.0K`. Omit `precision` only for an exact integer score. The server rejects a
display, numeric representative and `roundedTo` that do not describe the same value.

## SvS and King of Icefield phase scores

Signup sessions (`full`, `first`, `last`) describe attendance windows and are never scoring phases. Phase-specific points use `preparation` or `castle_battle`.

Read context:

```bash
python3 scripts/s26.py phase-score-context EVENT_ID castle_battle
```

An officer-issued reader receives the exact Player ID registry and current leaderboard. A non-officer reader receives only scores belonging to the issuer's linked accounts.

Preview payload:

```json
{
  "expectedVersion": 0,
  "coverage": "partial",
  "playerPoints": [
    {
      "playerId": "401250554",
      "points": 91473892,
      "provenance": { "sourceName": "Wenzy", "displayName": "Wenzy" }
    }
  ],
  "source": {
    "type": "owner_report",
    "reference": "KOI-castle-battle-scores-fixture.json"
  }
}
```

```bash
python3 scripts/s26.py put-phase-scores EVENT_ID castle_battle scores.json
```

The preview returns exact before/after rows, added/changed/unchanged counts, before/after reported-player subtotals, the next version, and `expectedHash`. It has no write effect. Omitted players remain unchanged; unknown and duplicate Player IDs reject the entire batch. Preserve raw names and confirmed corrections in `provenance`. Never turn missing scores into zero or call a partial subtotal an alliance total.

After an officer approves that exact preview:

```bash
python3 scripts/s26.py put-phase-scores EVENT_ID castle_battle scores.json --apply --expected-hash HASH_FROM_PREVIEW --reason "Officer approved exact castle-battle scores" --idempotency-key koi-EVENT_ID-castle-v1
python3 scripts/s26.py phase-score-context EVENT_ID castle_battle
```

Apply requires `results:write`, a current officer/owner issuer, the reviewed hash, explicit approval added by the CLI, a meaningful reason, and a unique idempotency key. Retry only the identical request with the same key. Account creation is deliberately outside `results:write`; quarantine unresolved identities until an officer onboards them separately.
