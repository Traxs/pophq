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
- A positive player-points row is treated as participation evidence throughout POP HQ. Zero
  points and omitted players remain unknown; neither is converted into absence.
- Results can only be recorded after that session starts.
- Use the current version returned by context. A stale version is rejected.
- Apply additionally requires `reason`, query `apply=true`, and an `Idempotency-Key` header of 8–100 safe characters.
- The same key and exact payload replay the first success. The same key with different data returns a conflict.

Individual points are returned to officers and the affected player in the web app, not to other members.
