import type { Repository } from "../data/repository.js";
import { parseAgentToken, tokenHashMatches, type AgentScope, type AgentTokenRecord } from "../domain/agentTokens.js";
import { ForbiddenError, UnauthorizedError } from "../domain/errors.js";

const UNUSED_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** Re-checks the issuing person's live permissions for every bot request. */
export type BotIssuerCanUse = (issuedBy: string, required: AgentScope) => Promise<boolean>;

export async function authenticateAgent(
  repo: Repository,
  authorization: string | undefined,
  origin: string | undefined,
  required: AgentScope,
  now: Date,
  issuerCanUse: BotIssuerCanUse,
): Promise<AgentTokenRecord> {
  if (origin) throw new ForbiddenError("Bot tokens cannot be used from a browser.");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  const parsed = bearer ? parseAgentToken(bearer) : undefined;
  if (!parsed) throw new UnauthorizedError("A valid bot token is required.");
  const record = await repo.getAgentToken(parsed.tokenId);
  if (!record || !tokenHashMatches(parsed.token, record.tokenHash)) throw new UnauthorizedError("Invalid bot token.");
  if (record.revokedAt) throw new UnauthorizedError("This bot token was revoked.");
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new UnauthorizedError("This bot token expired.");
  const lastActivity = Date.parse(record.lastUsedAt ?? record.createdAt);
  if (lastActivity + UNUSED_LIMIT_MS <= now.getTime()) throw new UnauthorizedError("This bot token expired after 30 days without use.");
  if (!record.scopes.includes(required)) throw new ForbiddenError(`This bot token needs the ${required} scope.`);
  if (!(await issuerCanUse(record.issuedBy, required))) {
    throw new ForbiddenError("The person who issued this bot token no longer has permission for this action.");
  }
  await repo.touchAgentToken(record.tokenId, now);
  return record;
}

export function publicAgentToken(record: AgentTokenRecord) {
  return {
    tokenId: record.tokenId,
    name: record.name,
    scopes: record.scopes,
    issuedBy: record.issuedBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}
