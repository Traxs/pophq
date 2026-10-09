import type { EventKind, EventListItem, EventOutcome } from "./api";

export interface EventTimelinePoint {
  eventId: string;
  title: string;
  startsAt: string;
  current: boolean;
  results: number;
  wins: number;
  losses: number;
  draws: number;
  ourScore: number | null;
  opponentScore: number | null;
  performance: number | null;
  alliancePlace: number | null;
  allianceCount: number | null;
  participants: number | null;
  preparation: number | null;
  battle: number | null;
  phaseCoverage: "partial" | "complete" | null;
  phaseScope: "alliance" | "mine" | null;
}

const countOutcome = (outcomes: EventOutcome[], outcome: EventOutcome) => outcomes.filter((value) => value === outcome).length;

/** Comparable, oldest-to-newest history points for one event type. */
export function eventTimeline(items: EventListItem[], kind: EventKind, currentEventId: string): EventTimelinePoint[] {
  return items
    .filter((item) => item.kind === kind && item.history)
    .map((item): EventTimelinePoint => {
      const results = item.history?.results ?? [];
      const phases = item.history?.phases ?? [];
      const allianceTotals = new Map<string, { score: number; ours: boolean }>();
      for (const result of results) {
        if (result.allianceScores && result.allianceScores.length > 0) {
          for (const alliance of result.allianceScores) {
            const key = alliance.isOurAlliance ? "__ours__" : `${alliance.allianceTag}:${alliance.allianceName}`.toLowerCase();
            const current = allianceTotals.get(key);
            allianceTotals.set(key, { score: (current?.score ?? 0) + alliance.score, ours: alliance.isOurAlliance });
          }
        } else {
          const ours = allianceTotals.get("__ours__");
          const opponent = allianceTotals.get("__legacy_opponent__");
          allianceTotals.set("__ours__", { score: (ours?.score ?? 0) + result.ourScore, ours: true });
          allianceTotals.set("__legacy_opponent__", { score: (opponent?.score ?? 0) + result.opponentScore, ours: false });
        }
      }
      const rankedAlliances = [...allianceTotals.values()].toSorted((a, b) => b.score - a.score);
      const ours = rankedAlliances.find((alliance) => alliance.ours);
      const ourScore = ours?.score ?? (results.length > 0 ? 0 : null);
      const opponentScore = rankedAlliances.find((alliance) => !alliance.ours)?.score ?? (results.length > 0 ? 0 : null);
      const totalScore = rankedAlliances.reduce((sum, alliance) => sum + alliance.score, 0);
      const alliancePlace = ours ? rankedAlliances.findIndex((alliance) => alliance === ours) + 1 : null;
      const preparation = phases.find((phase) => phase.phaseKey === "preparation");
      const battle = phases.find((phase) => phase.phaseKey === "castle_battle");
      const outcomes = results.map((result) => result.outcome);
      const coverage = phases.length === 0
        ? null
        : phases.every((phase) => phase.coverage === "complete") ? "complete" : "partial";
      return {
        eventId: item.eventId,
        title: item.title,
        startsAt: item.startsAt,
        current: item.eventId === currentEventId,
        results: results.length,
        wins: countOutcome(outcomes, "win"),
        losses: countOutcome(outcomes, "loss"),
        draws: countOutcome(outcomes, "draw"),
        ourScore,
        opponentScore,
        performance: results.length > 0 && totalScore > 0 ? (ourScore! / totalScore) * 100 : null,
        alliancePlace,
        allianceCount: results.length > 0 ? rankedAlliances.length : null,
        participants: results.some((result) => result.participants !== undefined)
          ? results.reduce((sum, result) => sum + (result.participants ?? 0), 0)
          : null,
        preparation: preparation?.reportedPlayerSubtotal ?? null,
        battle: battle?.reportedPlayerSubtotal ?? null,
        phaseCoverage: coverage,
        phaseScope: phases[0]?.scope ?? null,
      };
    })
    .filter((point) => point.results > 0 || point.preparation !== null || point.battle !== null)
    .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
