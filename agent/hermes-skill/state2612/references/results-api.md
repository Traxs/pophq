# Results API

All requests use `Authorization: Bearer $POPHQ_AGENT_TOKEN`. Agent tokens are refused when an `Origin` header is present.

## Read context

`GET /v1/agent/events/{eventId}/sessions/{sessionId}/result-context`

Returns the event, session, published lineup with numeric Player IDs and names, and the current result or `null`.

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
- Each Player ID appears at most once and must already exist in POP HQ.
- Results can only be recorded after that session starts.
- Use the current version returned by context. A stale version is rejected.
- Apply additionally requires `reason`, query `apply=true`, and an `Idempotency-Key` header of 8–100 safe characters.
- The same key and exact payload replay the first success. The same key with different data returns a conflict.

Individual points are returned to officers and the affected player in the web app, not to other members.
