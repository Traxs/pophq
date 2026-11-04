# Troop FC levels and Helios

Use `troops:write`, explicitly selected when a current POP R4/R5 issues a token. Existing tokens do not gain this permission. This updates POPHQ records, not the game itself. Never infer troop levels from furnace levels or resolve a player by name alone.

`POST /v1/agent/accounts/{exactPlayerId}/troops` previews by default. Use a source-backed observation with an ISO timestamp and only the troop fields being updated:

```json
{
  "effectiveAt": "2026-11-04T10:00:00Z",
  "sourceReference": "Player-confirmed troop screenshot",
  "troops": {
    "infantry": {"level": "FC8", "helios": true},
    "lancer": {"level": "FC7"},
    "marksman": {"helios": false}
  }
}
```

Levels accept 1–30 or FC1–FC10, optionally with substeps -1 through -5. Helios must be a JSON boolean. Omitted fields stay unchanged. A troop level cannot exceed the furnace level recorded for the observation date; record the furnace first if missing. Future observations are rejected.

```sh
python3 scripts/s26.py put-troops PLAYER_ID troop-report.json
python3 scripts/s26.py put-troops PLAYER_ID troop-report.json --apply --expected-hash HASH_FROM_PREVIEW --reason "Player confirmed these troop levels" --idempotency-key troop-observation-001
```

Review `before`, `after`, and `values`, obtain approval of that exact change, then apply the same file and preview hash. The CLI adds `approved: true`; direct API callers must supply it plus `reason`, `expectedHash`, `?apply=true`, and an `Idempotency-Key` header. Never automatically approve changed data. A stale preview returns 409: preview again and review the new diff. Retry an uncertain request with the identical body and key; keys are retained for 24 hours. Read back the exact player's reports to verify.

Each apply appends an immutable, source-labelled report with issuing token and reason in audit metadata. It cannot edit accounts, furnace levels, scores, or login access. Current issuer authority is checked on every request. Historical observations may not change current values when a newer report exists; inspect the preview.
