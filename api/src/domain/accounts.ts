import { z } from "zod";
import { ValidationError } from "./errors.js";
import { parseGameName, parsePlayerId } from "./identity.js";

export const ACCOUNT_STATUSES = ["active", "transferred_out", "archived", "guest", "unknown"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const RANKS = ["R1", "R2", "R3", "R4", "R5"] as const;
export type Rank = (typeof RANKS)[number];

/** A game account, identified by its in-game Player ID. All game data belongs to it. */
export interface GameAccount {
  playerId: string;
  name: string;
  alliance: string;
  rank?: Rank;
  status: AccountStatus;
}

const AllianceCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,6}$/, "Alliance code must be 2–6 letters or digits.")
  .transform((s) => s.toUpperCase());

const NewAccountSchema = z.object({
  playerId: z.unknown(),
  name: z.unknown(),
  alliance: AllianceCode.default("POP"),
  rank: z.enum(RANKS).optional(),
  status: z.enum(["active", "guest"]).default("active"),
});

/** Validates officer input for creating a member or guest account. */
export function parseNewAccount(input: unknown): GameAccount {
  const parsed = NewAccountSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid account.", z.flattenError(parsed.error).fieldErrors);
  }
  const { rank, ...rest } = parsed.data;
  const account: GameAccount = {
    playerId: parsePlayerId(rest.playerId),
    name: parseGameName(rest.name),
    alliance: rest.alliance,
    status: rest.status,
  };
  if (rank) account.rank = rank;
  // Guests belong to other alliances; members of POP are never guests.
  if (account.status === "guest" && account.alliance === "POP") {
    throw new ValidationError("A POP member can't be a guest.");
  }
  return account;
}
