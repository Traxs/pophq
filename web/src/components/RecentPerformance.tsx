import { useId, useState } from "react";
import type { EventKind, EventListItem } from "../api";
import { shortDate } from "../format";
import { playerScoreText } from "../resultDisplay";

const KIND_LABELS: Record<EventKind, string> = {
  foundry: "Foundry",
  svs: "SvS",
  koi: "King of Icefield",
  fdt: "FDT",
  canyon: "Canyon Clash",
  tundra: "Tundra League",
  bear: "Bear hunt",
  other: "Alliance event",
};

export function latestCompletedEvents(items: readonly EventListItem[], now = new Date()): EventListItem[] {
  return items
    .filter((event) => Date.parse(event.startsAt) < now.getTime())
    .toSorted((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .slice(0, 3);
}

export interface PlacementPoint {
  key: string;
  at: string;
  eventId: string;
  eventTitle: string;
  scoreLabel: string;
  place: number;
  scoredPlayers: number;
  /** Comparable 0–1 position in the recorded field; 1 means first place. */
  performance: number;
}

export function placementTrend(items: readonly EventListItem[], limit = 8): PlacementPoint[] {
  return items
    .flatMap((event) => (event.history?.mine?.scores ?? []).map((score) => ({
      key: `${event.eventId}:${score.key}`,
      at: event.startsAt,
      eventId: event.eventId,
      eventTitle: event.title,
      scoreLabel: score.label,
      place: score.place,
      scoredPlayers: score.scoredPlayers,
      performance: score.scoredPlayers <= 1 ? 1 : 1 - ((score.place - 1) / (score.scoredPlayers - 1)),
    })))
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key))
    .slice(-limit);
}

export function RecentPerformance({
  events,
  onOpen,
  onAllHistory,
}: {
  events: EventListItem[] | null | undefined;
  onOpen: (eventId: string) => void;
  onAllHistory: () => void;
}) {
  if (events === null) return null;
  const recent = events === undefined ? undefined : latestCompletedEvents(events);
  const placements = events === undefined ? [] : placementTrend(events);

  return <section className="stack recent-performance" aria-labelledby="recent-performance-title">
    <div className="recent-performance-head">
      <div>
        <h2 id="recent-performance-title" className="section-label">Your recent performance</h2>
        <p className="muted small">Attendance, scores and alliance place from your latest events.</p>
      </div>
      <button type="button" className="text-btn" onClick={onAllHistory}>All event history</button>
    </div>

    {events === undefined ? (
      <div className="recent-performance-grid" aria-label="Loading recent event performance" aria-busy="true">
        {[0, 1, 2].map((key) => <div key={key} className="card skeleton recent-performance-skeleton" />)}
      </div>
    ) : recent!.length === 0 ? (
      <div className="card empty recent-performance-empty">
        <strong>No completed events yet</strong>
        <span className="muted small">Your attendance and scores will appear here after an event.</span>
      </div>
    ) : (
      <>
        <PlacementTrend points={placements} onOpen={onOpen} />
        <div className="recent-performance-grid">
          {recent!.map((event) => <RecentEvent key={event.eventId} event={event} onOpen={onOpen} />)}
        </div>
      </>
    )}
  </section>;
}

function PlacementTrend({ points, onOpen }: { points: PlacementPoint[]; onOpen: (eventId: string) => void }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  if (points.length < 2) return <div className="card placement-trend-empty">
    <strong>Placement trend</strong>
    <span className="muted small">Two recorded placements are needed to draw your trend.</span>
  </div>;

  const width = 640;
  const height = 150;
  const pad = { top: 17, right: 12, bottom: 25, left: 12 };
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index: number) => pad.left + (index * (width - pad.left - pad.right)) / (points.length - 1);
  const y = (performance: number) => pad.top + (1 - performance) * plotHeight;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.performance).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${height - pad.bottom} L${x(0).toFixed(1)},${height - pad.bottom} Z`;
  const shown = active ?? points.length - 1;
  const selected = points[shown]!;

  return <div className="card placement-trend">
    <div className="placement-trend-head">
      <span><strong>Placement trend</strong><small>Last {points.length} recorded results · higher is better</small></span>
      <button type="button" className="placement-trend-current" onClick={() => onOpen(selected.eventId)}>
        <strong>#{selected.place} <small>of {selected.scoredPlayers}</small></strong>
        <span>{selected.eventTitle} · {selected.scoreLabel}</span>
      </button>
    </div>
    <figure className="placement-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Placement trend from number ${points[0]!.place} of ${points[0]!.scoredPlayers} to number ${selected.place} of ${selected.scoredPlayers}`}
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          <linearGradient id={`${id}-placement-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((position) => <line
          key={position}
          x1={pad.left}
          y1={pad.top + position * plotHeight}
          x2={width - pad.right}
          y2={pad.top + position * plotHeight}
          className="chart-grid-line"
        />)}
        <path d={area} fill={`url(#${id}-placement-fill)`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => <g key={point.key}>
          <circle
            cx={x(index)}
            cy={y(point.performance)}
            r={index === shown ? 5 : 3.5}
            fill={index === shown ? "var(--accent)" : "var(--surface)"}
            stroke="var(--accent)"
            strokeWidth="2"
          />
          <rect
            x={x(index) - 20}
            y="0"
            width="40"
            height={height}
            fill="transparent"
            onMouseEnter={() => setActive(index)}
            onClick={() => setActive(index)}
          />
        </g>)}
        <text x={pad.left} y={height - 6} className="chart-axis" textAnchor="start">{shortDate(points[0]!.at)}</text>
        <text x={width - pad.right} y={height - 6} className="chart-axis" textAnchor="end">{shortDate(points.at(-1)!.at)}</text>
        <text x={pad.left} y={pad.top - 5} className="chart-axis" textAnchor="start">Top of field</text>
      </svg>
      <table className="visually-hidden">
        <caption>Your recorded event placements</caption>
        <tbody>{points.map((point) => <tr key={point.key}>
          <th scope="row">{point.eventTitle}, {point.scoreLabel}, {shortDate(point.at)}</th>
          <td>#{point.place} of {point.scoredPlayers}</td>
        </tr>)}</tbody>
      </table>
    </figure>
  </div>;
}

function RecentEvent({ event, onOpen }: { event: EventListItem; onOpen: (eventId: string) => void }) {
  const performance = event.history?.mine;
  const hasScores = Boolean(performance && performance.scores.length > 0);
  const attendance = performance?.attendance ?? "not_reviewed";
  const attendanceLabel = attendance === "attended"
    ? "Attended"
    : attendance === "did_not_attend"
      ? "Did not attend"
      : attendance === "excused"
        ? "Excused"
        : "Not recorded";
  const attendanceClass = attendance === "attended"
    ? "pill-up"
    : attendance === "did_not_attend"
      ? "pill-down"
      : attendance === "excused"
        ? "pill-warn"
        : "pill-flat";

  const cardClass = [
    "card",
    "recent-performance-card",
    hasScores ? "" : "recent-performance-card-empty",
    attendance === "did_not_attend" ? "recent-performance-card-missed" : "",
  ].filter(Boolean).join(" ");

  const header = <span className="recent-performance-card-head">
    <span>
      <small>{KIND_LABELS[event.kind]} · {shortDate(event.startsAt)}</small>
      <strong>{event.title}</strong>
    </span>
    <span className={`pill ${attendanceClass}`}>{attendanceLabel}</span>
  </span>;

  if (!hasScores) return <article className={cardClass}>
    {header}
    <span className="recent-performance-empty-row"><small>No individual score recorded</small></span>
  </article>;

  return <button type="button" className={cardClass} onClick={() => onOpen(event.eventId)}>
    {header}

    <span className="recent-performance-scores">
      {performance!.scores.map((score) => <span key={score.key}>
        <small>{score.label}</small>
        <strong>{playerScoreText(score)} pts</strong>
        <b>#{score.place} of {score.scoredPlayers}</b>
      </span>)}
    </span>

    <span className="recent-performance-link">View event <span aria-hidden="true">›</span></span>
  </button>;
}
