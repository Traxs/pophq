import type { Repository } from "../data/repository.js";
import { parseAgentToken, tokenHashMatches, type AgentScope, type AgentTokenRecord } from "../domain/agentTokens.js";
import { ForbiddenError, UnauthorizedError } from "../domain/errors.js";

const UNUSED_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

export async function authenticateAgent(
  repo: Repository,
  authorization: string | undefined,
  origin: string | undefined,
  required: AgentScope,
  now: Date,
): Promise<AgentTokenRecord> {
  if (origin) throw new ForbiddenError("Agent tokens cannot be used from a browser.");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  const parsed = bearer ? parseAgentToken(bearer) : undefined;
  if (!parsed) throw new UnauthorizedError("A valid agent token is required.");
  const record = await repo.getAgentToken(parsed.tokenId);
  if (!record || !tokenHashMatches(parsed.token, record.tokenHash)) throw new UnauthorizedError("Invalid agent token.");
  if (record.revokedAt) throw new UnauthorizedError("This agent token was revoked.");
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new UnauthorizedError("This agent token expired.");
  const lastActivity = Date.parse(record.lastUsedAt ?? record.createdAt);
  if (lastActivity + UNUSED_LIMIT_MS <= now.getTime()) throw new UnauthorizedError("This agent token expired after 30 days without use.");
  if (!record.scopes.includes(required)) throw new ForbiddenError(`This agent token needs the ${required} scope.`);
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
