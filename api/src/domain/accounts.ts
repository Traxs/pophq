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
  /** An officer's note: why someone is a guest, that they are on holiday, and so on. */
  note?: string;
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

/**
 * Changes an officer may make to an account. Written out rather than derived from the create
 * schema: that one has defaults, and a partial version of it would quietly reset the fields an
 * officer never mentioned.
 *
 * Archiving is not here. It is a retention decision with its own rules (P4.5), not a roster edit.
 */
const AccountChangesSchema = z.object({
  name: z.unknown().optional(),
  alliance: AllianceCode.optional(),
  /** Empty string clears a rank nobody knows. */
  rank: z.union([z.enum(RANKS), z.literal("")]).optional(),
  status: z.enum(["active", "guest", "unknown", "transferred_out"]).optional(),
  /** An officer's note about this account; empty string removes it. */
  note: z.string().trim().max(200).optional(),
});

export function parseAccountChanges(account: GameAccount, input: unknown): GameAccount {
  const parsed = AccountChangesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid change.", z.flattenError(parsed.error).fieldErrors);
  const changes = parsed.data;
  if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");

  const updated: GameAccount = {
    playerId: account.playerId,
    name: changes.name === undefined ? account.name : parseGameName(changes.name),
    alliance: changes.alliance ?? account.alliance,
    status: changes.status ?? account.status,
  };
  const rank = changes.rank === undefined ? account.rank : changes.rank || undefined;
  if (rank) updated.rank = rank;
  const note = changes.note === undefined ? account.note : changes.note || undefined;
  if (note) updated.note = note;

  if (updated.status === "guest" && updated.alliance === "POP") {
    throw new ValidationError("A POP member can't be a guest.");
  }
  if (updated.status !== "guest" && updated.alliance !== "POP") {
    throw new ValidationError(`Someone in ${updated.alliance} is a guest here, not a member.`);
  }
  return updated;
}
