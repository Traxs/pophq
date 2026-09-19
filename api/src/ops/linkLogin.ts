// Owner bootstrap: link a Cognito login to a game account, creating the account if needed.
// Used by scripts/admin.ts until the officer inbox (P4) covers this in the app.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { parseNewAccount, type GameAccount } from "../domain/accounts.js";
import { NotFoundError } from "../domain/errors.js";

export interface LinkLoginInput {
  email: string;
  playerId: string;
  name: string;
  rank?: string;
  alliance?: string;
}

export interface LinkLoginDeps {
  repo: Repository;
  /** Finds the login's subject (Cognito `sub`) by email. */
  findSub: (email: string) => Promise<string | undefined>;
  actor: Actor;
}

export interface LinkLoginResult {
  sub: string;
  account: GameAccount;
  accountCreated: boolean;
  linked: boolean;
}

export async function linkLogin({ repo, findSub, actor }: LinkLoginDeps, input: LinkLoginInput): Promise<LinkLoginResult> {
  const wanted = parseNewAccount({
    playerId: input.playerId,
    name: input.name,
    ...(input.rank ? { rank: input.rank } : {}),
    ...(input.alliance ? { alliance: input.alliance } : {}),
  });

  const sub = await findSub(input.email.trim().toLowerCase());
  if (!sub) throw new NotFoundError(`No login with email ${input.email}. Create the Cognito user first.`);

  // An existing account is kept as it is; names and ranks change through the app.
  const existing = await repo.getAccount(wanted.playerId);
  if (!existing) await repo.createAccount(wanted, actor);

  const already = (await repo.linkedAccounts(sub)).includes(wanted.playerId);
  if (!already) await repo.linkAccount(sub, wanted.playerId, actor);

  return { sub, account: existing ?? wanted, accountCreated: !existing, linked: !already };
}
