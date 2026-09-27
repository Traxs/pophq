# Login-free account onboarding API

Account onboarding requires `accounts:write` and a token issued by a user who is still a POP R4/R5 or owner. Existing tokens do not gain this scope. The guarded API exists only to create or reuse game-account records by exact Player ID and attach immutable source evidence.

It never creates an invitation, email, password, login, credential, sign-in seat, or human ownership link. It never infers main/alternate relationships, changes membership, or writes scores. Those are separate reviewed workflows.

The same guarded route repairs confirmed operational aliases on an **existing exact Player ID**. Alias repair preserves the canonical account and cannot create a shell. `sourceScoreName` remains evidence only; use the explicit `aliases` collection when the name must resolve operationally.

## Input fixture

Use the same source fixture for preview and apply. The CLI supplies `batchId`, so the file may contain `alliance`, optional `eventId` and `phaseKey`, and 1–19 entries:

```json
{
  "alliance": "POP",
  "eventId": "EVENT_ID",
  "phaseKey": "castle_battle",
  "entries": [
    {
      "sourceId": "stable-source-row",
      "playerId": "390464931",
      "name": "POPs Creature",
      "sourceScoreName": "POPs Creature",
      "pendingCastleBattlePoints": 123456,
      "identityEvidence": "owner_supplied_exact_player_id",
      "historicalSpreadsheetEvidence": {
        "row": 17,
        "name": "Shadow Creature",
        "status": "historical_source_claim"
      },
      "sourceCorrections": [
        { "observed": "source typo", "correctedTo": "POPs Creature", "status": "input_typo_not_alias" }
      ]
    }
  ]
}
```

For a confirmed non-spreadsheet alias, keep `name` equal to the existing canonical name and add one or more source-backed aliases:

```json
{
  "alliance": "POP",
  "entries": [{
    "sourceId": "confirmed-name-401250554",
    "playerId": "401250554",
    "name": "Wenzy",
    "aliases": [{
      "name": "Wenzyporsche",
      "source": {
        "kind": "owner_confirmation",
        "reference": "TRAX-545/owner-confirmation.json",
        "note": "Owner confirmed the same exact game account."
      }
    }]
  }]
}
```

Supported source kinds are `owner_confirmation`, `verified_screenshot`, `historical_spreadsheet`, and `imported_name_history`. Alias names are 2–30 Unicode characters after NFKC normalization. `sourceId` and `source.reference` are 1–200 characters; `source.note` is optional and at most 500; `source.observedAt` is an optional ISO timestamp and must be omitted when unknown. Legacy `identityEvidence` remains limited to 80 characters and is required for shell onboarding but not for alias-only repair. Never silently truncate a field.

The packaged preview-only 13-row case is [POPHQ-confirmed-aliases-fixture.json](POPHQ-confirmed-aliases-fixture.json). Its presence is not production-apply approval.

The packaged seven-account KOI case is [POPHQ-seven-shell-accounts-fixture.json](POPHQ-seven-shell-accounts-fixture.json). It is account-reconciliation input only; its pending points are deliberately not an approved score write.

`playerId` must be the exact numeric game ID. Set it to `null` when the source has no verified ID; the API preserves an unresolved evidence record and does not invent an account. Names are used only for conflict detection and source-backed aliases—never as a fuzzy match key. `sourceCorrections` preserve observed typos/transcription corrections inside evidence and do not create aliases. Pending points are provenance only and are not imported by this endpoint.

## Preview and review

```bash
python3 scripts/s26.py reconcile-accounts POPHQ-seven-shell-accounts-fixture.json \
  --batch-id koi-2026-09-26-seven
```

The preview returns `expectedHash`, `applicable`, an exhaustive row per input, and counts for `create`, `reuse`, `unresolved`, `conflicts`, aliases, and evidence. Each row is one of:

- `create_shell`: create an ordinary POP account with `status: unknown` and no login.
- `reuse_exact`: retain the exact existing account unchanged and attach only missing evidence.
- `preserve_unresolved`: preserve the source row without creating an account.
- `conflict`: apply is blocked; resolve it without guessing.

Each explicit alias also has one decision: `add_alias`, `already_present`, `already_resolves_cosmetically`, `conflict`, or `invalid_source`. Review `existingAliases`, `aliasAdditions`, `aliasReviews`, `batchIssues`, and `transactionOperations`. `aliasesToAdd: 0` is not an alias repair even when evidence is added. Repeated aliases may add distinct source provenance without duplicating the operational alias.

Matching uses NFKC, case folding and collapsed whitespace only. Punctuation and digits remain significant. There is no fuzzy, substring, dropped-number, or homoglyph matching. A normalized name claimed by another Player ID blocks the whole atomic apply.

Verify the response's `effects` flags are all `false`. Review every before/after account, alias, evidence record, and issue. A preview performs no writes.

## Apply after separate approval

Only after an officer explicitly approves that exact account diff:

```bash
python3 scripts/s26.py reconcile-accounts POPHQ-seven-shell-accounts-fixture.json \
  --batch-id koi-2026-09-26-seven \
  --apply \
  --expected-hash HASH_FROM_PREVIEW \
  --reason "Approved exact-ID shell onboarding" \
  --idempotency-key koi-2026-09-26-account-shells-v1
```

Apply is one atomic batch. It requires `approved: true` (added by the CLI), a reason, the reviewed hash, and an 8–100 character idempotency key. Retrying exactly the same request with the same key is safe. Never reuse the key for changed data. A stale preview, duplicate ID, name/alias collision, changed existing account, or lost officer authority blocks all writes.

`expectedHash` binds the complete current-state preview (including decisions, before/after accounts, aliases and evidence). The idempotency receipt separately binds the exact approved apply payload—including the reason and expected hash—to the supplied key. Equal empty-state hashes never make different payloads interchangeable. After an uncertain network outcome, read back the account and retry only the identical payload with the same key; never switch keys blindly.

Read one completed identity and its evidence:

```bash
python3 scripts/s26.py account-reconciliation 390464931
```

This returns the exact account, whether it now has a login, its aliases, `aliasSources`, and all onboarding source records. Resolve a canonical name or operational alias through the supported importer lookup:

```bash
python3 scripts/s26.py resolve-account-name Wenzyporsche
```

The resolver returns `resolved` only for one unambiguous exact/cosmetic key and explains whether the basis is `canonical` or `alias`. An empty or ambiguous result must stop automatic import matching. A later verified sign-in link attaches to the existing Player ID; the account and its historical evidence remain unchanged.

## Scores remain separate

After account onboarding is complete, run a fresh phase-score context and score preview. Present that score-only diff for a new approval. Never treat approval of account shells as approval to import pending scores.
