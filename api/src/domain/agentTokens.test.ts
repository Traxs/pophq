import { describe, expect, it } from "vitest";
import { canonicalJson, hashAgentToken, issueAgentToken, parseAgentToken, tokenHashMatches } from "./agentTokens.js";

describe("agent tokens", () => {
  it("issues a one-time 256-bit secret and stores only its hash", () => {
    const issued = issueAgentToken({ name: "Hermes", scopes: ["all:read", "results:write"], expiresInDays: 30 }, "officer", new Date("2026-09-20T00:00:00Z"));
    expect(parseAgentToken(issued.token)?.tokenId).toBe(issued.record.tokenId);
    expect(issued.record.tokenHash).toBe(hashAgentToken(issued.token));
    expect(issued.record.tokenHash).not.toContain(issued.token);
    expect(tokenHashMatches(issued.token, issued.record.tokenHash)).toBe(true);
    expect(tokenHashMatches(issued.token.replace(/.$/, "x"), issued.record.tokenHash)).toBe(false);
  });

  it("limits scope and lifetime", () => {
    expect(() => issueAgentToken({ name: "Hermes", scopes: ["admin"] }, "officer", new Date())).toThrow();
    expect(() => issueAgentToken({ name: "Hermes", scopes: ["all:read"], expiresInDays: 91 }, "officer", new Date())).toThrow();
  });

  it("canonicalises equivalent request bodies for idempotent retries", () => {
    expect(canonicalJson({ score: 1, nested: { b: 2, a: 1 } })).toBe(canonicalJson({ nested: { a: 1, b: 2 }, score: 1 }));
  });
});
