# Fortress and Stronghold rewards API

Reward registration requires `rewards:write` and a token issued by a person who currently has a linked POP R4 or R5 account. The permission stops working immediately if that rank is removed. It registers inventory only; it cannot assign rewards to members.

## Extract a screenshot safely

Read the visible reward icons and quantities from the game screenshot. Do not infer a quantity hidden by cropping, turn an unreadable value into zero, or merge the two hero-shard pools. Ask the officer to resolve any uncertain row before previewing.

Supported quantity keys and the common pictured amounts are:

| Key | Reward | Common amount |
| --- | --- | ---: |
| `allocatable` | Allocatable reward chests | 40 |
| `speedup` | 1-hour General Speedup | 400 |
| `health` | Troops Health Up II (12hrs) | 60 |
| `hero_shard` | Renee Shard | 200 |
| `teleport` | Advanced Teleporter | 90 |
| `damage` | Troops Damage Up II (12hrs) | 60 |
| `deployment` | Deployment Capacity Boost II (12hrs) | 60 |
| `stronghold_material` | Lucky Hero Gear Chest | 150 |
| `stronghold_component` | Pet Advancement Materials Custom Chest | 100 |
| `stronghold_hero_shard` | Wayne Shard | 420 |
| `fire_crystal` | Fire Crystal | 600 |

The legacy-looking keys are stable API identifiers; the reward column contains the exact in-game item identity for the current POP reward phase. The amounts are recognition hints, not constants. Use the number visible in the supplied screenshot. Set a supported reward to `0` only when the reviewed screenshot establishes that it was not won; otherwise resolve the uncertainty first.

POP HQ attaches its reviewed per-unit Gem-equivalent valuation to each registered pool. The bot must not multiply quantities into the submitted quantity field, replace named shards with generic shard values, or invent a value for an unknown item. The website calculates pool, assignment and recipient-cycle totals from the registered quantity and preserved per-unit valuation.

## Payload

`POST /v1/agent/rewards` defaults to preview. Use a stable, unique `batchId` for the battle haul; 3–60 letters, digits, dots, underscores or hyphens are accepted.

```json
{
  "batchId": "fortress-2026-09-22-phase-3",
  "source": "Fortress battle phase 3",
  "acquiredAt": "2026-09-22T18:00:00.000Z",
  "quantities": {
    "allocatable": 40,
    "speedup": 400,
    "health": 60,
    "hero_shard": 200,
    "teleport": 90,
    "damage": 60,
    "deployment": 60,
    "stronghold_material": 150,
    "stronghold_component": 100,
    "stronghold_hero_shard": 420,
    "fire_crystal": 600
  }
}
```

Preview and show the returned `diff.before`, `diff.after`, and `expectedHash` to the officer:

```bash
python3 scripts/s26.py put-rewards rewards.json
```

After explicit approval of that exact diff, apply with the preview hash, a meaningful reason, and a new idempotency key:

```bash
python3 scripts/s26.py put-rewards rewards.json --apply --expected-hash HASH_FROM_PREVIEW --reason "Officer approved screenshot extraction" --idempotency-key rewards-20260922-phase3
```

Retry the identical request with the same idempotency key after an uncertain network response. Never reuse a key for different data. A reused `batchId` with different inventory is rejected.

## Boundaries

- Preview never writes.
- Browser-origin bot requests are rejected.
- Normal web write routes remain forbidden to bot tokens.
- `rewards:write` does not create events, update results, import history, change member eligibility, or assign inventory to recipients.
- Keep the original screenshot available for the human review; this endpoint stores the structured inventory, not the image itself.
