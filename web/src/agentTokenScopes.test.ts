import { describe, expect, it } from "vitest";
import { missingIssuedScopes, requestedAgentScopes } from "./agentTokenScopes";

describe("bot token scope issuance", () => {
  it("includes account onboarding when its checkbox is selected", () => {
    expect(requestedAgentScopes({ results: true, events: true, history: true, rewards: true, accounts: true })).toEqual([
      "all:read",
      "results:write",
      "events:write",
      "history:write",
      "rewards:write",
      "accounts:write",
    ]);
  });

  it("spots a backend response that silently lost a selected scope", () => {
    expect(missingIssuedScopes(
      ["all:read", "accounts:write"],
      ["all:read"],
    )).toEqual(["accounts:write"]);
  });
});
