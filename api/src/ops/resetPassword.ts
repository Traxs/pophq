import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import type { AccessAuditRecord } from "../domain/access.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import type { LoginDirectory } from "./invite.js";

export async function resetMemberPassword(
  { repo, logins, actor }: { repo: Repository; logins: LoginDirectory; actor: Actor },
  playerId: string,
  justification: string,
): Promise<{ credentials: { password: string }; audit: AccessAuditRecord }> {
  if (!(await repo.getAccount(playerId))) throw new NotFoundError(`Game account ${playerId} not found.`);
  const access = await repo.linkedLoginAccess(playerId);
  if (!access) throw new NotFoundError("This member does not have a sign-in.");
  if (access.loginMethod !== "password") {
    throw new ValidationError("Password reset is available only for members invited with password access.");
  }

  const actorAccounts = await repo.linkedAccounts(actor.id);
  const actorAccount = actorAccounts.length > 0 ? await repo.getAccount(actorAccounts[0]!) : undefined;
  const requested = await repo.startPasswordReset(playerId, justification, actor, actorAccount?.name);
  let credentials: { password: string };
  try {
    credentials = await logins.resetPassword(access.sub);
  } catch (error) {
    await repo.finishPasswordReset(playerId, requested.auditId, "failed", actor).catch(() => undefined);
    throw error;
  }
  const audit = await repo.finishPasswordReset(playerId, requested.auditId, "completed", actor);
  return { credentials, audit };
}
