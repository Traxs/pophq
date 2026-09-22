import type { FortressBuff } from "./api";

export const REWARD_NAMES: Record<FortressBuff, string> = {
  allocatable: "Allocatable reward chest",
  speedup: "1-hour General Speedup",
  health: "Troops Health Up II (12hrs)",
  hero_shard: "Renee Shard",
  teleport: "Advanced Teleporter",
  damage: "Troops Damage Up II (12hrs)",
  deployment: "Deployment Capacity Boost II (12hrs)",
  stronghold_material: "Lucky Hero Gear Chest",
  stronghold_component: "Pet Advancement Materials Custom Chest",
  stronghold_hero_shard: "Wayne Shard",
  fire_crystal: "Fire Crystal",
};

export const REWARD_DESCRIPTIONS: Partial<Record<FortressBuff, string>> = {
  health: "+20% Troops Health for 12 hours",
  damage: "+20% Troops Lethality for 12 hours",
  deployment: "+20% Deployment Capacity for 12 hours",
  stronghold_material: "Rare or better Hero Gear; random quality",
  stronghold_component: "Choose 7 Taming Manuals, 2 Energizing Potions, or 1 Strengthening Serum",
};

export const REWARD_IMAGES: Record<FortressBuff, string> = {
  allocatable: "/buffs/allocatable.png",
  speedup: "/buffs/speedup.png",
  health: "/buffs/health.png",
  hero_shard: "/buffs/hero-shard.png",
  teleport: "/buffs/teleport.png",
  damage: "/buffs/damage.png",
  deployment: "/buffs/deployment.png",
  stronghold_material: "/buffs/stronghold-material.png",
  stronghold_component: "/buffs/stronghold-component.png",
  stronghold_hero_shard: "/buffs/hero-shard.png",
  fire_crystal: "/buffs/fire-crystal.png",
};
