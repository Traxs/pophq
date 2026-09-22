import { ForbiddenError } from "./errors.js";

export type Group = "player" | "officer" | "owner";

export interface AccessAccount {
  alliance: string;
  rank?: string;
  status: string;
}

/** Who is calling, derived from a verified token plus the login's verified account links. */
export interface Principal {
  sub: string;
  groups: ReadonlySet<Group>;
  /** Player IDs verified as belonging to this login (main + alts). */
  linkedAccounts: ReadonlySet<string>;
  /** Account selected in the switcher (X-Account-Id), already checked against linkedAccounts. */
  actingAs?: string;
}

export const isOfficer = (p: Principal): boolean => p.groups.has("officer") || p.groups.has("owner");

/**
 * R4/R5 is the alliance's operational officer role. Imported accounts may still be unconfirmed
 * when their login is linked, so `unknown` remains eligible; former members and guests do not.
 */
export const grantsOfficerAccess = (account: AccessAccount | undefined): boolean =>
  account?.alliance === "POP"
  && (account.rank === "R4" || account.rank === "R5")
  && (account.status === "active" || account.status === "unknown");

/** Cognito roles remain valid, while a linked current POP R4/R5 gains officer access immediately. */
export function effectiveGroups(claim: unknown, accounts: readonly (AccessAccount | undefined)[]): Set<Group> {
  const groups = parseGroups(claim);
  if (accounts.some(grantsOfficerAccess)) groups.add("officer");
  return groups;
}

export function requireOfficer(p: Principal): void {
  if (!isOfficer(p)) throw new ForbiddenError("Only officers can do this.");
}

/**
 * Resolves the X-Account-Id header (FM-04): a login may only act as an account it is linked to.
 * Officers are no exception; they act on other accounts through officer routes, recorded as themselves.
 */
export function resolveActingAccount(header: string | undefined, linked: ReadonlySet<string>): string | undefined {
  if (header === undefined || header === "") return undefined;
  if (!linked.has(header)) throw new ForbiddenError("That game account isn't linked to your login.");
  return header;
}

/**
 * The account a read applies to: the one chosen with X-Account-Id, or the only linked account.
 * With several alts and no choice, reads stay account-neutral rather than guessing.
 */
export function defaultActing(p: Principal): string | undefined {
  if (p.actingAs) return p.actingAs;
  return p.linkedAccounts.size === 1 ? [...p.linkedAccounts][0] : undefined;
}

/** Players may write for their own linked accounts; officers for any account. */
export function requireCanWriteFor(p: Principal, playerId: string): "player" | "officer" {
  if (p.linkedAccounts.has(playerId)) return "player";
  if (isOfficer(p)) return "officer";
  throw new ForbiddenError("You can only submit data for your own game accounts.");
}

/** Maps token group claims to known groups; unknown values are ignored. */
export function parseGroups(claim: unknown): Set<Group> {
  const raw = Array.isArray(claim) ? claim : typeof claim === "string" ? claim.split(/[\s,]+/) : [];
  const out = new Set<Group>(["player"]);
  for (const g of raw) if (g === "officer" || g === "owner") out.add(g);
  return out;
}
