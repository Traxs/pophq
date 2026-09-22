/** Rewards an R4/R5 distributes after Fortress and Stronghold battles. */
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const FORTRESS_BUFFS = [
  "allocatable",
  "speedup",
  "health",
  "hero_shard",
  "teleport",
  "damage",
  "deployment",
  "stronghold_material",
  "stronghold_component",
  "stronghold_hero_shard",
  "fire_crystal",
] as const;
export type FortressBuff = (typeof FORTRESS_BUFFS)[number];

export interface RewardGemValuation {
  /** Gem-equivalent range per single displayed reward unit. */
  min: number;
  max: number;
  confidence: "high" | "medium" | "low";
  basis: string;
}

/**
 * Defaults are copied into every new pool so historical decisions do not change when
 * game prices or our research changes later. Named hero shards and variable chests
 * intentionally stay unvalued until POP chooses an alliance-specific baseline.
 */
export const DEFAULT_REWARD_VALUATIONS: Partial<Record<FortressBuff, RewardGemValuation>> = {
  speedup: { min: 550, max: 800, confidence: "low", basis: "Community Gem-equivalent range" },
  health: { min: 20_000, max: 20_000, confidence: "medium", basis: "20% 12-hour City Bonus price" },
  teleport: { min: 4_000, max: 4_000, confidence: "high", basis: "Direct in-game Gem alternative" },
  damage: { min: 20_000, max: 20_000, confidence: "medium", basis: "20% 12-hour City Bonus price" },
  deployment: { min: 20_000, max: 20_000, confidence: "low", basis: "20% 12-hour City Bonus comparison" },
  stronghold_material: { min: 2_000, max: 2_000, confidence: "low", basis: "Lucky Hero Gear Chest community valuation" },
  stronghold_component: { min: 3_000, max: 3_000, confidence: "low", basis: "Pet Advancement chest community valuation" },
  fire_crystal: { min: 500, max: 500, confidence: "medium", basis: "Community event-shop comparison" },
};

export interface FortressBuffPool {
  poolId: string;
  /** Stable identity shared by every reward pool registered in one takeover cycle. */
  batchId?: string;
  alliance: string;
  buff: FortressBuff;
  quantity: number;
  remaining: number;
  source: string;
  acquiredAt: string;
  /** When POP HQ registered this cycle; distinct from the battle date. */
  registeredAt?: string;
  createdBy: string;
  gemValuation?: RewardGemValuation;
}

export interface FortressBuffAssignment {
  poolId: string;
  playerId: string;
  amount: number;
  /** Immutable explanation of why this account was eligible when the officer assigned it. */
  eligibility?: {
    position: number;
    eligibleThrough: number;
    score: number;
    participationRate: number;
    strength: number;
    strongestStrength: number;
    strengthShare: number;
    kudosShare: number;
    weights: { participation: number; strength: number; kudos: number };
  };
  assignedAt: string;
  assignedBy: string;
  status: "recommended" | "confirmed";
  confirmedAt?: string;
  confirmedBy?: string;
}

const NewPoolSchema = z.object({
  buff: z.enum(FORTRESS_BUFFS),
  quantity: z.number().int().min(1, "Register at least one reward unit.").max(10_000, "At most 10,000 units per reward batch."),
  source: z.string().trim().min(2, "Say which Fortress or Stronghold supplied it.").max(60),
  acquiredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Use a valid acquisition date.")
    .transform((value) => new Date(value).toISOString())
    .optional(),
});

const BulkPoolSchema = z.object({
  quantities: z.object({
    allocatable: z.number().int().min(0).max(10_000),
    speedup: z.number().int().min(0).max(10_000),
    health: z.number().int().min(0).max(100),
    hero_shard: z.number().int().min(0).max(10_000),
    teleport: z.number().int().min(0).max(10_000),
    damage: z.number().int().min(0).max(100),
    deployment: z.number().int().min(0).max(100),
    stronghold_material: z.number().int().min(0).max(10_000),
    stronghold_component: z.number().int().min(0).max(10_000),
    stronghold_hero_shard: z.number().int().min(0).max(10_000),
    fire_crystal: z.number().int().min(0).max(10_000),
  }),
  source: z.string().trim().min(2, "Say which Fortress or Stronghold supplied it.").max(60),
  acquiredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Use a valid acquisition date.")
    .transform((value) => new Date(value).toISOString())
    .optional(),
}).refine((value) => Object.values(value.quantities).some((quantity) => quantity > 0), {
  message: "Enter at least one reward.",
  path: ["quantities"],
});

export function parseFortressBuffPool(
  input: unknown,
  ctx: { poolId: string; batchId?: string; alliance: string; createdBy: string; now: Date },
): FortressBuffPool {
  const parsed = NewPoolSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid Fortress buff batch.", z.flattenError(parsed.error).fieldErrors);
  }
  return {
    poolId: ctx.poolId,
    ...(ctx.batchId ? { batchId: ctx.batchId } : {}),
    alliance: ctx.alliance,
    buff: parsed.data.buff,
    quantity: parsed.data.quantity,
    remaining: parsed.data.quantity,
    source: parsed.data.source,
    acquiredAt: parsed.data.acquiredAt ?? ctx.now.toISOString(),
    registeredAt: ctx.now.toISOString(),
    createdBy: ctx.createdBy,
    ...(DEFAULT_REWARD_VALUATIONS[parsed.data.buff]
      ? { gemValuation: DEFAULT_REWARD_VALUATIONS[parsed.data.buff] }
      : {}),
  };
}

/** Turns one officer's weekly haul into one inventory pool per selected reward type. */
export function parseFortressBuffPools(
  input: unknown,
  ctx: { poolIds: Record<FortressBuff, string>; batchId?: string; alliance: string; createdBy: string; now: Date },
): FortressBuffPool[] {
  const parsed = BulkPoolSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid Fortress buff haul.", z.flattenError(parsed.error).fieldErrors);
  }
  const acquiredAt = parsed.data.acquiredAt ?? ctx.now.toISOString();
  return FORTRESS_BUFFS.flatMap((buff) => {
    const quantity = parsed.data.quantities[buff];
    return quantity === 0 ? [] : [{
      poolId: ctx.poolIds[buff],
      ...(ctx.batchId ? { batchId: ctx.batchId } : {}),
      alliance: ctx.alliance,
      buff,
      quantity,
      remaining: quantity,
      source: parsed.data.source,
      acquiredAt,
      registeredAt: ctx.now.toISOString(),
      createdBy: ctx.createdBy,
      ...(DEFAULT_REWARD_VALUATIONS[buff] ? { gemValuation: DEFAULT_REWARD_VALUATIONS[buff] } : {}),
    }];
  });
}
