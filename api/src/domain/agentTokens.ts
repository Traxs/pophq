import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const AGENT_SCOPES = ["results:read", "results:write"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export interface AgentTokenRecord {
  tokenId: string;
  name: string;
  tokenHash: string;
  scopes: AgentScope[];
  issuedBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

const IssueSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(AGENT_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

export const hashAgentToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Stable JSON for idempotency hashes: object key order must not change request identity. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function tokenHashMatches(token: string, expected: string): boolean {
  const actual = Buffer.from(hashAgentToken(token), "hex");
  const stored = Buffer.from(expected, "hex");
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

export function issueAgentToken(input: unknown, issuedBy: string, now: Date): { token: string; record: AgentTokenRecord } {
  const parsed = IssueSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid agent token request.", z.flattenError(parsed.error).fieldErrors);
  const tokenId = ulid(now.getTime()).toLowerCase();
  const token = `s26_${tokenId}_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    record: {
      tokenId,
      name: parsed.data.name,
      tokenHash: hashAgentToken(token),
      scopes: [...new Set(parsed.data.scopes)],
      issuedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

export function parseAgentToken(value: string): { tokenId: string; token: string } | undefined {
  const match = /^(s26_([0-9a-z]{26})_[A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] && match[2] ? { tokenId: match[2], token: match[1] } : undefined;
}
