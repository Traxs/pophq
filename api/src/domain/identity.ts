import { ValidationError } from "./errors.js";

// Invisible and control characters used to smuggle text past humans
// (zero-width, bidi overrides, Unicode "tag" characters, C0/C1 controls).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]|[\u{e0000}-\u{e007f}]/u;

const PLAYER_ID = /^[1-9][0-9]{4,14}$/;

/** Validates an in-game Player ID: digits only, 5–15 long, no leading zero. */
export function parsePlayerId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!PLAYER_ID.test(value)) {
    throw new ValidationError("Player ID must be 5–15 digits without a leading zero.");
  }
  return value;
}

/**
 * Validates an in-game name as entered (raw spelling is kept).
 * Rejects invisible and control characters; length 2–30 after NFKC normalisation.
 */
export function parseGameName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("Name is required.");
  const name = raw.normalize("NFKC").trim();
  if (FORBIDDEN_CHARS.test(name)) {
    throw new ValidationError("Name contains invisible or control characters.");
  }
  const length = [...name].length;
  if (length < 2 || length > 30) throw new ValidationError("Name must be 2–30 characters.");
  return name;
}

/** Search form of a name: NFKC, case-folded, whitespace collapsed. Never shown to users. */
export function searchKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface AccountAlias {
  name: string;
  addedAt: string;
  addedBy: string;
}

export type IdentityAuditAction = "link_secondary" | "unlink_secondary" | "set_main" | "alias_add" | "membership_left" | "membership_restored";

export interface IdentityAuditRecord {
  auditId: string;
  action: IdentityAuditAction;
  subjectPlayerId: string;
  relatedPlayerId?: string;
  alias?: string;
  affectedPlayerIds?: string[];
  justification: string;
  performedAt: string;
  performedBy: string;
  performedByName?: string;
}

export interface MembershipPeriod {
  /** Inclusive moment this person belonged to POP. */
  from: string;
  /** Exclusive moment they left. Missing while membership is current. */
  to?: string;
}

/**
 * Reconstructs the periods in which a person belonged to POP. Membership changes are already
 * permanent audit records, so a return opens a new period instead of making the time away look
 * like missed events. Older accounts without membership audit retain their original createdAt.
 */
export function membershipPeriods(
  createdAts: readonly string[],
  audits: readonly IdentityAuditRecord[],
  currentlyIncluded: boolean,
): MembershipPeriod[] {
  const firstKnown = createdAts.filter(Boolean).toSorted()[0];
  const changes = audits
    .filter((audit) => audit.action === "membership_left" || audit.action === "membership_restored")
    .filter((audit, index, all) => all.findIndex((item) => item.auditId === audit.auditId) === index)
    .toSorted((a, b) => a.performedAt.localeCompare(b.performedAt));
  // Legacy accounts have no membership-change audit. An empty list deliberately means
  // "unrestricted legacy history" so imported evidence from before account creation survives.
  if (changes.length === 0) return [];
  // Older membership writes accidentally replaced account.createdAt. When the first durable
  // fact is a departure and createdAt is no earlier, the person necessarily belonged before
  // that departure; keep their earlier imported history instead of discarding it.
  let open = changes[0]?.action === "membership_left" && (!firstKnown || firstKnown >= changes[0].performedAt)
    ? "1970-01-01T00:00:00.000Z"
    : firstKnown;
  const periods: MembershipPeriod[] = [];
  for (const change of changes) {
    if (change.action === "membership_left") {
      if (open && change.performedAt > open) periods.push({ from: open, to: change.performedAt });
      open = undefined;
    } else if (!open) {
      open = change.performedAt;
    }
  }
  if (currentlyIncluded && open) periods.push({ from: open });
  return periods;
}

export function wasMemberAt(periods: readonly MembershipPeriod[], at: string): boolean {
  if (periods.length === 0) return true;
  return periods.some((period) => at >= period.from && (period.to === undefined || at < period.to));
}

export function parseIdentityJustification(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("A reason is required.");
  const value = raw.normalize("NFKC").trim();
  if (FORBIDDEN_CHARS.test(value)) throw new ValidationError("Reason contains invisible or control characters.");
  if ([...value].length < 5 || [...value].length > 200) {
    throw new ValidationError("Reason must be 5–200 characters.");
  }
  return value;
}
