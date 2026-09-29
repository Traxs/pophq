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
import { resetMemberPassword } from "./resetPassword.js";

export interface PublicOnboardingInvite {
  playerId: string;
  playerName: string;
  expiresAt: string;
  purpose: "onboarding" | "password_recovery";
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
    purpose: "onboarding",
    createdAt: at.toISOString(),
    createdBy: actor.id,
    expiresAt: expiresAt.toISOString(),
    expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000),
  };
  await repo.issueOnboardingInvite(invitation, tokenHash, actor);
  return { token, invitation };
}

export async function issuePasswordRecoveryInvite(
  repo: Repository,
  playerId: string,
  justification: string,
  actor: Actor,
  at = new Date(),
): Promise<{ token: string; invitation: OnboardingInvite }> {
  const account = await repo.getAccount(playerId);
  if (!account) throw new NotFoundError(`Game account ${playerId} not found.`);
  const access = await repo.linkedLoginAccess(playerId);
  if (access?.loginMethod !== "password") {
    throw new ConflictError("Password recovery links are available only for password-based POP HQ access.");
  }
  const { token, tokenHash } = createOnboardingToken();
  const expiresAt = new Date(at.getTime() + ONBOARDING_INVITE_TTL_MS);
  const invitation: OnboardingInvite = {
    inviteId: ulid(at.getTime()),
    playerId,
    playerName: account.name,
    status: "issued",
    purpose: "password_recovery",
    justification,
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
  const [account, access] = await Promise.all([repo.getAccount(invitation.playerId), repo.linkedLoginAccess(invitation.playerId)]);
  const purpose = invitation.purpose ?? "onboarding";
  const accessMatches = purpose === "password_recovery"
    ? access?.loginMethod === "password" && access.activeRecoveryInviteId === invitation.inviteId
    : access === undefined;
  if (!account || !accessMatches || !["active", "guest", "unknown"].includes(account.status)) {
    throw new NotFoundError("This invitation is invalid, expired, or has already been used.");
  }
  return {
    invitation,
    public: { playerId: invitation.playerId, playerName: account.name, expiresAt: invitation.expiresAt, purpose },
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
  const purpose = invitation.purpose ?? "onboarding";
  const method = purpose === "password_recovery" ? "password" : parseOnboardingMethod(input.method);
  const email = method === "email" ? parseEmail(String(input.email ?? "")) : undefined;
  const loginName = method === "password" && purpose === "onboarding" ? parsePrivateLoginName(input.loginName) : undefined;

  // A friendly login maps one-to-one to this reserved Cognito identifier. Check before claiming
  // the bearer link so a typo/collision can be corrected without burning the invitation. Cognito's
  // conditional create remains the authority if two people race for the same name.
  if (loginName && await deps.logins.findSub(`${loginName}@members.pophq.invalid`)) {
    throw new ConflictError("That login name is already in use. Choose another name; your invitation is still valid.");
  }

  await deps.repo.claimOnboardingInvite(tokenHash, invitation, method, at);
  const actor: Actor = { id: `invite:${invitation.inviteId}`, via: "web", reason: "one-time onboarding invitation redeemed" };
  let result: InviteResult;
  try {
    if (purpose === "password_recovery") {
      const account = await deps.repo.getAccount(invitation.playerId);
      if (!account) throw new NotFoundError(`Game account ${invitation.playerId} not found.`);
      const access = await deps.repo.linkedLoginAccess(invitation.playerId);
      const username = access?.loginIdentifier ?? (access ? await deps.logins.identifierFor?.(access.sub) : undefined);
      if (!username) throw new ConflictError("The login name could not be recovered. Ask an R4 to reset access directly.");
      const reset = await resetMemberPassword(
        { repo: deps.repo, logins: deps.logins, actor },
        invitation.playerId,
        invitation.justification ?? "Player used an officer-issued recovery invitation",
      );
      result = {
        account,
        accountCreated: false,
        loginCreated: false,
        linked: false,
        credentials: { username, password: reset.credentials.password },
        seats: await deps.repo.seats(),
      };
    } else {
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
    }
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
