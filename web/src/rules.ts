// Small business rules the UI needs before calling the API. Keep them in step with the API:
// the level pattern mirrors api/src/domain/measurements.ts (the API remains the authority).
import { daysBetween } from "./format";

/** A member should report power at least this often. */
export const REPORT_DUE_DAYS = 30;

/** Overdue: never reported, or the last report is REPORT_DUE_DAYS or more old. */
export function isReportOverdue(lastReportAt: string | null | undefined, now: Date = new Date()): boolean {
  return !lastReportAt || daysBetween(new Date(lastReportAt), now) >= REPORT_DUE_DAYS;
}

// Furnace and troop levels as shown in game: 1–30, then FC1–FC10 with optional sub-steps (FC5-2).
const LEVEL = /^(?:[1-9]|[12][0-9]|30|FC(?:[1-9]|10)(?:-[1-4])?)$/;
export const LEVEL_HINT = "Use 1–30 or FC1–FC10, e.g. FC5-2.";

export const isValidLevel = (value: string): boolean => LEVEL.test(value.trim().toUpperCase());

// Same rules as the API (api/src/domain/identity.ts, ops/invite.ts).
const PLAYER_ID = /^[1-9][0-9]{4,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isValidPlayerId = (value: string): boolean => PLAYER_ID.test(value.trim());
export const isValidEmail = (value: string): boolean => EMAIL.test(value.trim()) && value.trim().length <= 254;
export const isValidGameName = (value: string): boolean => {
  const n = value.trim();
  return n.length >= 2 && n.length <= 30;
};

/** Label under the account name: the app role (not the game rank) plus the rank if known. */
export function roleLabel(groups: readonly string[], rank: string | undefined, alliance: string): string {
  const role = groups.includes("owner") ? "Site owner" : groups.includes("officer") ? "Officer" : undefined;
  if (!role) return rank ?? alliance;
  return rank ? `${role} · ${rank}` : role;
}

/**
 * A level as a comparable number: 1–30 as themselves, then FC1–FC10 above them, with a sub-step
 * as a fraction. So 30 < FC1 < FC5-2 < FC6. Undefined for anything that is not a level.
 */
export function levelRank(value: string): number | undefined {
  const s = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!isValidLevel(s)) return undefined;
  const fc = /^FC([1-9]|10)(?:-([1-4]))?$/.exec(s);
  if (!fc) return Number(s);
  return 30 + Number(fc[1]) + (fc[2] ? Number(fc[2]) / 10 : 0);
}

/**
 * Troops cannot be levelled past the furnace, so a troop level above it is usually a typo — or a
 * furnace figure that was never updated. The form says so and still saves: POP HQ records what a
 * member reports rather than arguing with them about the game.
 */
export function troopLevelExceedsFurnace(troopLevel: string, furnaceLevel: string): boolean {
  const troop = levelRank(troopLevel);
  const furnace = levelRank(furnaceLevel);
  if (troop === undefined || furnace === undefined) return false;
  return troop > furnace;
}
