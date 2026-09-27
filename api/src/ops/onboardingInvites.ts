import { ulid } from "ulid";
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { ConflictError, DomainError, NotFoundError } from "../domain/errors.js";
import {
  ONBOARDING_INVITE_TTL_MS,
  createOnboardingToken,
  hashOnboardingToken,
  parseOnboardingMethod,
  parseOnboardingToken,
  parsePrivateLoginName,
  type OnboardingInvite,
} from "../domain/onboardingInvites.js";
import { invite, parseEmail, type InviteResult, type LoginDirectory } from "./invite.js";

export interface PublicOnboardingInvite {
  playerId: string;
  playerName: string;
  expiresAt: string;
}

export async function issueOnboardingInvite(
  repo: Repository,
  playerId: string,
  actor: Actor,
  at = new Date(),
): Promise<{ token: string; invitation: OnboardingInvite }> {
  const account = await repo.getAccount(playerId);
  if (!account) throw new NotFoundError(`Game account ${playerId} not found.`);
  if (await repo.linkedLogin(playerId)) throw new ConflictError(`${account.name} already has POP HQ access.`);
  const { token, tokenHash } = createOnboardingToken();
  const expiresAt = new Date(at.getTime() + ONBOARDING_INVITE_TTL_MS);
  const invitation: OnboardingInvite = {
    inviteId: ulid(at.getTime()),
    playerId,
    playerName: account.name,
    status: "issued",
    createdAt: at.toISOString(),
    createdBy: actor.id,
    expiresAt: expiresAt.toISOString(),
    expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000),
  };
  await repo.issueOnboardingInvite(invitation, tokenHash, actor);
  return { token, invitation };
}

export async function inspectOnboardingInvite(
  repo: Repository,
  rawToken: unknown,
  at = new Date(),
): Promise<{ invitation: OnboardingInvite; public: PublicOnboardingInvite }> {
  const token = parseOnboardingToken(rawToken);
  const invitation = await repo.getOnboardingInvite(hashOnboardingToken(token));
  // One response for all invalid states prevents public account/status discovery.
  if (!invitation || invitation.status !== "issued" || Date.parse(invitation.expiresAt) < at.getTime()) {
    throw new NotFoundError("This invitation is invalid, expired, or has already been used.");
  }
  const [account, linked] = await Promise.all([repo.getAccount(invitation.playerId), repo.linkedLogin(invitation.playerId)]);
  if (!account || linked || !["active", "guest", "unknown"].includes(account.status)) {
    throw new NotFoundError("This invitation is invalid, expired, or has already been used.");
  }
  return {
    invitation,
    public: { playerId: invitation.playerId, playerName: account.name, expiresAt: invitation.expiresAt },
  };
}

export async function redeemOnboardingInvite(
  deps: { repo: Repository; logins: LoginDirectory; at?: Date },
  input: { token: unknown; method: unknown; email?: unknown; loginName?: unknown },
): Promise<{ account: InviteResult["account"]; method: "email" | "password"; signInIdentifier: string; credentials?: { username: string; password: string } }> {
  const at = deps.at ?? new Date();
  const token = parseOnboardingToken(input.token);
  const tokenHash = hashOnboardingToken(token);
  const { invitation } = await inspectOnboardingInvite(deps.repo, token, at);
  const method = parseOnboardingMethod(input.method);
  const email = method === "email" ? parseEmail(String(input.email ?? "")) : undefined;
  const loginName = method === "password" ? parsePrivateLoginName(input.loginName) : undefined;

  await deps.repo.claimOnboardingInvite(tokenHash, invitation, method, at);
  const actor: Actor = { id: `invite:${invitation.inviteId}`, via: "web", reason: "one-time onboarding invitation redeemed" };
  let result: InviteResult;
  try {
    result = await invite(
      { repo: deps.repo, logins: deps.logins, actor },
      {
        loginMethod: method,
        ...(email ? { email } : {}),
        ...(loginName ? { loginName } : {}),
        playerId: invitation.playerId,
        name: invitation.playerName,
      },
    );
  } catch (err) {
    const failureCode = err instanceof DomainError ? err.code : "provider_error";
    await deps.repo.finishOnboardingInvite(tokenHash, invitation, "failed", at, failureCode).catch((auditError) => {
      console.error(JSON.stringify({
        level: "error",
        source: "api",
        kind: "onboarding_audit_failure",
        inviteId: invitation.inviteId,
        errorName: auditError instanceof Error ? auditError.name : "UnknownError",
      }));
    });
    if (err instanceof DomainError) throw err;
    throw new ConflictError("Access could not be created. The invitation is now closed; ask an R4 for a new one.");
  }
  // Access already exists at this point. Never hide one-time credentials because an audit write
  // had a transient failure; emit a structured alarm signal while the token remains consumed.
  await deps.repo.finishOnboardingInvite(tokenHash, invitation, "redeemed", at).catch((auditError) => {
    console.error(JSON.stringify({
      level: "error",
      source: "api",
      kind: "onboarding_audit_failure",
      inviteId: invitation.inviteId,
      errorName: auditError instanceof Error ? auditError.name : "UnknownError",
    }));
  });
  return {
    account: result.account,
    method,
    signInIdentifier: method === "email" ? email! : result.credentials!.username,
    ...(result.credentials ? { credentials: result.credentials } : {}),
  };
}
