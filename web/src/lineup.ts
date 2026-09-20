// What the lineup editor works on. The API is the authority (api/src/domain/lineups.ts);
// this only prepares what an officer sees before they publish.
import type { LineupRole, SessionView } from "./api";

/** A row in the editor: someone who signed up, or someone already in the published lineup. */
export interface LineupDraftRow {
  playerId: string;
  name: string;
  foundryStrength: number | null;
  /** "out" means not in the lineup; it is not sent to the API. */
  role: LineupRole | "out";
  /** False when an officer added them although they never answered. */
  signedUp: boolean;
}

/**
 * The editor opens on the published lineup when there is one, and on the estimate when there is
 * not, so the common case is "check and publish" rather than "start from nothing".
 */
export function draftFor(session: SessionView): LineupDraftRow[] {
  const signUps = new Map(session.signedUpList.map((e) => [e.playerId, e]));
  if (session.lineup) {
    const rows: LineupDraftRow[] = session.lineup.entries.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      foundryStrength: e.foundryStrength,
      role: e.role,
      signedUp: e.signedUp,
    }));
    const inLineup = new Set(rows.map((r) => r.playerId));
    // Anyone who signed up after the lineup was published belongs in the list as "out",
    // otherwise an officer cannot see them without leaving the editor.
    for (const entry of session.signedUpList) {
      if (!inLineup.has(entry.playerId)) {
        rows.push({
          playerId: entry.playerId,
          name: entry.name,
          foundryStrength: entry.foundryStrength,
          role: "out",
          signedUp: true,
        });
      }
    }
    return rows;
  }
  return [...signUps.values()].map((entry) => ({
    playerId: entry.playerId,
    name: entry.name,
    foundryStrength: entry.foundryStrength,
    role: entry.likely,
    signedUp: true,
  }));
}

export interface DraftCounts {
  starters: number;
  subs: number;
  /** True when the draft asks for more starters or substitutes than the session takes. */
  overCapacity: boolean;
}

export function countDraft(rows: readonly LineupDraftRow[], session: Pick<SessionView, "starters" | "subs">): DraftCounts {
  const starters = rows.filter((r) => r.role === "starter").length;
  const subs = rows.filter((r) => r.role === "sub").length;
  return {
    starters,
    subs,
    overCapacity:
      (session.starters !== undefined && starters > session.starters) ||
      (session.subs !== undefined && subs > session.subs),
  };
}

/** What the API wants: starters first, then substitutes, each in the order shown. */
export function entriesToPublish(rows: readonly LineupDraftRow[]): { playerId: string; role: LineupRole }[] {
  return [
    ...rows.filter((r) => r.role === "starter"),
    ...rows.filter((r) => r.role === "sub"),
  ].map((r) => ({ playerId: r.playerId, role: r.role as LineupRole }));
}
