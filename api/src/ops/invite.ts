// Officers invite people: create the login if needed, create the game account if needed, link them.
// Safe to repeat: running the same invite twice changes nothing and reports what was already there.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { parseNewAccount, type GameAccount } from "../domain/accounts.js";
import { ConflictError, ValidationError } from "../domain/errors.js";
import { SEAT_CAP, seatsLeft, type Seats } from "../domain/seats.js";

/** The logins directory (Cognito in AWS, a local stand-in in development). */
export interface LoginDirectory {
  /** The login's subject for this email, or undefined if there is none. */
  findSub(email: string): Promise<string | undefined>;
  /** Creates a login that signs in with emailed codes only; returns its subject. */
  createLogin(email: string): Promise<string>;
  /** Creates an email-free login with a temporary password that must be changed at first sign-in. */
  createPasswordLogin(): Promise<{ sub: string; username: string; password: string }>;
  /** Removes a login again; used only to undo a creation that could not be completed. */
  deleteLogin(sub: string): Promise<void>;
}

export interface InviteInput {
  /** Old clients infer email when present and otherwise create only the roster account. */
  loginMethod?: "email" | "password" | "none";
  email?: string;
  playerId: string;
  name: string;
  rank?: string;
  alliance?: string;
}

export interface InviteResult {
  account: GameAccount;
  accountCreated: boolean;
  /** The login's subject, when the invite included an email. */
  sub?: string;
  loginCreated: boolean;
  linked: boolean;
  /** Returned exactly once for a newly created password login; never stored by POP HQ. */
  credentials?: { username: string; password: string };
  seats: Seats;
}

export interface InviteDeps {
  repo: Repository;
  logins: LoginDirectory;
  actor: Actor;
  seatCap?: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new ValidationError("Enter a valid email address.");
  return email;
}

export async function invite(
  { repo, logins, actor, seatCap = SEAT_CAP }: InviteDeps,
  input: InviteInput,
): Promise<InviteResult> {
  const wanted = parseNewAccount({
    playerId: input.playerId,
    name: input.name,
    ...(input.rank ? { rank: input.rank } : {}),
    ...(input.alliance ? { alliance: input.alliance } : {}),
  });
  const method = input.loginMethod ?? (input.email?.trim() ? "email" : "none");
  const email = method === "email" ? parseEmail(input.email ?? "") : undefined;
  if (method !== "email" && input.email?.trim()) throw new ValidationError("Email is only used for email-code invitations.");

  const existing = await repo.getAccount(wanted.playerId);
  const alreadyLinkedSub = await repo.linkedLogin(wanted.playerId);
  let sub = alreadyLinkedSub;
  let loginCreated = false;
  let credentials: InviteResult["credentials"];
  if (method === "email") {
    const emailSub = await logins.findSub(email!);
    if (alreadyLinkedSub && emailSub !== alreadyLinkedSub) {
      throw new ConflictError(`${existing?.name ?? wanted.name} already has a sign-in.`);
    }
    sub = emailSub;
    if (!sub) {
      // Check before creating so a full alliance doesn't leave an unusable login behind; the
      // seat reservation below is the authority if two officers invite at the same moment.
      if (seatsLeft(await repo.seats(seatCap)) === 0) {
        throw new ValidationError(`All ${seatCap} sign-in seats are in use. Free one before inviting someone new.`);
      }
      sub = await logins.createLogin(email!);
      loginCreated = true;
    }
  } else if (method === "password" && !sub) {
    if (seatsLeft(await repo.seats(seatCap)) === 0) {
      throw new ValidationError(`All ${seatCap} sign-in seats are in use. Free one before inviting someone new.`);
    }
    const created = await logins.createPasswordLogin();
    sub = created.sub;
    credentials = { username: created.username, password: created.password };
    loginCreated = true;
  }

  if (sub) {
    try {
      await repo.reserveSeat(sub, actor, seatCap);
    } catch (err) {
      if (loginCreated) await logins.deleteLogin(sub).catch(() => undefined);
      throw err;
    }
  }

  let linked = false;
  try {
    if (!existing) await repo.createAccount(wanted, actor);
    if (sub && !alreadyLinkedSub && !(await repo.linkedAccounts(sub)).includes(wanted.playerId)) {
      await repo.linkAccount(sub, wanted.playerId, actor);
      linked = true;
    }
  } catch (err) {
    if (loginCreated && sub) {
      await repo.releaseSeat(sub).catch(() => undefined);
      await logins.deleteLogin(sub).catch(() => undefined);
    }
    throw err;
  }

  return {
    account: existing ?? wanted,
    accountCreated: !existing,
    ...(sub ? { sub } : {}),
    loginCreated,
    linked,
    ...(credentials ? { credentials } : {}),
    seats: await repo.seats(seatCap),
  };
}
