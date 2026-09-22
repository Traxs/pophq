import type { Repository } from "../data/repository.js";
import { parseAgentToken, tokenHashMatches, type AgentScope, type AgentTokenRecord } from "../domain/agentTokens.js";
import { ForbiddenError, UnauthorizedError } from "../domain/errors.js";
import type { Group } from "../domain/principal.js";

const UNUSED_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolves the issuing person's live groups for every bot request. */
export type BotIssuerGroups = (issuedBy: string) => Promise<ReadonlySet<Group> | undefined>;

export interface AuthenticatedBot {
  token: AgentTokenRecord;
  issuerGroups: ReadonlySet<Group>;
}

export async function authenticateAgent(
  repo: Repository,
  authorization: string | undefined,
  origin: string | undefined,
  required: AgentScope,
  now: Date,
  issuerGroupsFor: BotIssuerGroups,
): Promise<AuthenticatedBot> {
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
  const hasScope = record.scopes.includes(required)
    || (required === "all:read" && record.scopes.includes("results:read"));
  if (!hasScope) throw new ForbiddenError(`This bot token needs the ${required} scope.`);
  const issuerGroups = await issuerGroupsFor(record.issuedBy);
  if (!issuerGroups) throw new ForbiddenError("The person who issued this bot token no longer has an account.");
  if (required.endsWith(":write") && !issuerGroups.has("officer") && !issuerGroups.has("owner")) {
    throw new ForbiddenError("The person who issued this bot token no longer has permission for this action.");
  }
  await repo.touchAgentToken(record.tokenId, now);
  return { token: record, issuerGroups };
}

export function publicAgentToken(record: AgentTokenRecord) {
  const scopes = effectiveBotScopes(record);
  return {
    tokenId: record.tokenId,
    name: record.name,
    scopes,
    issuedBy: record.issuedBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}

export function effectiveBotScopes(record: AgentTokenRecord): AgentScope[] {
  return [
    ...(record.scopes.includes("all:read") || record.scopes.includes("results:read") ? ["all:read" as const] : []),
    ...(record.scopes.includes("results:write") ? ["results:write" as const] : []),
    ...(record.scopes.includes("events:write") ? ["events:write" as const] : []),
    ...(record.scopes.includes("history:write") ? ["history:write" as const] : []),
    ...(record.scopes.includes("rewards:write") ? ["rewards:write" as const] : []),
  ];
}
