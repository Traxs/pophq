# Fortress reward gem valuations

Research date: 22 September 2026. These are **gem-equivalent estimates**, not a universal exchange rate. Whiteout Survival has no single official conversion table; event shops, VIP shops, server generation and temporary discounts can produce different values.

| POP HQ reward | Gem value per unit | Confidence | Basis |
| --- | ---: | --- | --- |
| Troops Damage Up II (12hrs) | ~20,000 | Medium | The exact item grants +20% lethality for 12 hours; public City Bonus comparisons price this tier at 20,000 Gems. |
| Troops Health Up II (12hrs) | ~20,000 | Medium | The exact item grants +20% health for 12 hours and uses the same City Bonus tier. |
| Deployment Capacity Boost II (12hrs) | ~20,000 | Low | The exact item grants +20% deployment capacity for 12 hours; the public direct price found is from the closely related Kingshot economy, so POP HQ labels it low-confidence. |
| Advanced Teleporter | 4,000 | High | The game allows the same targeted relocation for 4,000 Gems when no item is available. |
| Renee Shard | Unknown | — | Named hero shards are generation- and acquisition-specific; do not substitute the generic Mythic shard value. |
| Wayne Shard | Unknown | — | Named hero shards are generation- and acquisition-specific; Wayne's known acquisition paths do not establish a direct Gem price. |
| Fire Crystal | 500 | Medium | Community event-shop and vault comparisons use 500 Gems per crystal. |
| 1-hour general speedup | ~550–800 | Low | Public comparisons disagree. Use a range until POP confirms the current in-game baseline it wants to follow. |
| Lucky Hero Gear Chest | ~2,000 | Low | Community value model; the actual contents are random: 89% Rare, 10% Epic, 1% Mythic. |
| Pet Advancement Materials Custom Chest | ~3,000 | Low | Community event-shop value model. Each chest selects 7 Taming Manuals, 2 Energizing Potions, or 1 Strengthening Serum. |
| Allocatable reward chest | Unknown | — | Contents vary, so the chest needs either an expected-content value or an R4-entered value. |

## Sources

- Whiteout Survival Wiki, Advanced Teleporter: https://www.whiteoutsurvival.wiki/items/advanced-teleporter/
- Whiteout Survival Wiki, Deployment Capacity Boost II (12h): https://www.whiteoutsurvival.wiki/items/deployment-capacity-boost-ii-12hrs/
- Whiteout Survival Wiki, Troops Health Up II (12hrs): https://www.whiteoutsurvival.wiki/items/troops-health-up-ii-12hrs/
- Whiteout Survival Wiki, Troops Damage Up II (12hrs): https://www.whiteoutsurvival.wiki/items/troops-damage-up-ii-12hrs/
- Whiteout Survival Wiki, Lucky Hero Gear Chest: https://www.whiteoutsurvival.wiki/items/lucky-hero-gear-chest/
- Whiteout Survival Wiki, Pet Advancement Materials Custom Chest: https://www.whiteoutsurvival.wiki/items/pet-advancement-materials-custom-chest/
- Vortex Gaming, Mysterious Vault gem-value comparison: https://vortexgaming.io/en/postdetail/778227
- Whiteout Survival Handbook, Alliance Showdown item scoring (useful as a secondary relative-value check, not a Gem price): https://www.whiteoutsurvivalhandbook.com/guides/whiteoutsurvival-alliance-showdown-guide-2026
- Community war-buff price report: https://www.reddit.com/r/whiteoutsurvival/comments/1dlrnm6/
- Community speedup valuation discussion: https://www.reddit.com/r/whiteoutsurvival/comments/1gpw958/

## Implementation rule

Do not rank or auto-recommend rewards whose exact item identity or Gem value is unknown. Store a per-unit Gem value and its source/confidence with each registered takeover cycle, prefill well-supported defaults, and let the R4 correct them before publishing recommendations. This prevents a later game update or a mislabeled Stronghold icon from silently producing unfair allocations.

All distribution totals are quantity-aware. For example, 50 one-hour General Speedups at the current 550–800 Gem estimate are shown as approximately 27,500–40,000 Gems. Known values are added across the whole takeover cycle per recipient. Unknown-value units are reported separately and never treated as zero-value rewards.

## Allocation order

Eligible members receive a target share of the cycle's known Gem-equivalent value proportional to their eligibility score. The recommendation planner processes the highest-value reward pools first and gives each next unit to the eligible member furthest below their target, breaking ties by rank. A per-pool cap of `ceil(pool quantity / eligible members)` creates complete distribution rounds, preventing even the #1 member from monopolising a repeatable buff. The remainder of a round goes by ranking, then divisible items such as General Speedups close the remaining value gaps. Existing assignments are included and R4/R5 officers retain the final override.

An allocation is initially **recommended and reserved**. It reduces unallocated inventory so the same units cannot be promised twice, but it is not historical proof of receipt. An R4/R5 must explicitly mark it **delivered** after handing it out in-game. Member Home, officer inventory and distribution history keep these states visibly separate.
