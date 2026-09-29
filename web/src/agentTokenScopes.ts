import type { AgentScope } from "./api";

export interface AgentWriteSelections {
  results: boolean;
  events: boolean;
  registrations: boolean;
  history: boolean;
  rewards: boolean;
  accounts: boolean;
}

/** The exact scope payload sent by the token form. Read access is always included. */
export function requestedAgentScopes(selected: AgentWriteSelections): AgentScope[] {
  return [
    "all:read",
    ...(selected.results ? ["results:write" as const] : []),
    ...(selected.events ? ["events:write" as const] : []),
    ...(selected.registrations ? ["registrations:write" as const] : []),
    ...(selected.history ? ["history:write" as const] : []),
    ...(selected.rewards ? ["rewards:write" as const] : []),
    ...(selected.accounts ? ["accounts:write" as const] : []),
  ];
}

/** Detects a mixed frontend/backend deployment before its one-time secret is exposed. */
export function missingIssuedScopes(requested: AgentScope[], issued: AgentScope[]): AgentScope[] {
  return requested.filter((scope) => !issued.includes(scope));
}
