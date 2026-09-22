import type { RosterRow } from "./api";

export function inviteSuggestions(candidates: readonly RosterRow[], query: string): RosterRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return candidates
    .filter((candidate) => !candidate.hasLogin)
    .filter((candidate) => candidate.name.toLowerCase().includes(q) || candidate.playerId.includes(q)
      || (candidate.aliases ?? []).some((alias) => alias.toLowerCase().includes(q)))
    .slice(0, 8);
}
