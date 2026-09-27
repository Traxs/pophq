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
      const ourScore = results.length > 0 ? results.reduce((sum, result) => sum + result.ourScore, 0) : null;
      const opponentScore = results.length > 0 ? results.reduce((sum, result) => sum + result.opponentScore, 0) : null;
      const totalScore = (ourScore ?? 0) + (opponentScore ?? 0);
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
