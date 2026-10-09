import type { EventListItem } from "../api";
import { playerScoreText } from "../resultDisplay";

type Performance = NonNullable<NonNullable<EventListItem["history"]>["mine"]>;
type Score = Performance["scores"][number];

const attendancePresentation = (attendance: Performance["attendance"] | undefined) => attendance === "attended"
  ? { label: "Attended", className: "pill-up" }
  : attendance === "did_not_attend"
    ? { label: "Did not attend", className: "pill-down" }
    : attendance === "excused"
      ? { label: "Excused", className: "pill-warn" }
      : { label: "Not recorded", className: "pill-flat" };

const comparableKey = (key: string) => key.startsWith("session:") ? "session" : key;
const normalizedPlacement = (score: Score) => score.scoredPlayers <= 1
  ? 1
  : 1 - ((score.place - 1) / (score.scoredPlayers - 1));

function previousComparable(event: EventListItem, history: readonly EventListItem[], score: Score): Score | undefined {
  return history
    .filter((item) => item.kind === event.kind && Date.parse(item.startsAt) < Date.parse(event.startsAt))
    .toSorted((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .flatMap((item) => item.history?.mine?.scores ?? [])
    .find((candidate) => comparableKey(candidate.key) === comparableKey(score.key));
}

/** A player's private completed-event summary. Officers still see their own data, never somebody else's. */
export function EventPersonalPerformance({
  performance,
  event,
  history = [],
}: {
  performance: Performance | undefined;
  event?: EventListItem;
  history?: readonly EventListItem[];
}) {
  const attendance = attendancePresentation(performance?.attendance);

  return (
    <section className="event-my-performance" aria-label="Your performance">
      <div className="event-my-performance-head">
        <strong>Your performance</strong>
        <span className={`pill ${attendance.className}`}>{attendance.label}</span>
      </div>
      {performance && performance.scores.length > 0 ? (
        <div className="event-my-score-list">
          {performance.scores.map((score) => {
            const previous = event ? previousComparable(event, history, score) : undefined;
            const change = previous ? (normalizedPlacement(score) - normalizedPlacement(previous)) * 100 : undefined;
            return <span key={score.key}>
              <small>{score.label}</small>
              <strong>{playerScoreText(score)} pts</strong>
              <b>#{score.place} of {score.scoredPlayers}</b>
              {previous && <em>
                Previous #{previous.place} of {previous.scoredPlayers}
                {change !== undefined && Math.abs(change) >= 0.05 ? ` · ${change > 0 ? "+" : ""}${change.toFixed(1)} percentile pts` : " · unchanged"}
              </em>}
            </span>;
          })}
        </div>
      ) : (
        <small>No individual score is recorded for you.</small>
      )}
      {performance?.attendanceEvidence === "score" && <small>Your recorded result confirms your attendance.</small>}
    </section>
  );
}
