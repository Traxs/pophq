import { useId, useState } from "react";
import { compact, full, shortDate } from "../format";

export interface ChartPoint {
  at: string;
  value: number;
}

/**
 * Small line chart in plain SVG: no charting dependency, and it reads well on a phone.
 * Tap or hover a point to see its exact value; the same numbers are also in a table for
 * screen readers.
 */
export function LineChart({
  points,
  label,
  height = 180,
  format = compact,
}: {
  points: ChartPoint[];
  label: string;
  height?: number;
  format?: (n: number) => string;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className="muted small">Not enough data yet for a chart.</p>;
  }

  const width = 320;
  const pad = { top: 12, right: 8, bottom: 22, left: 8 };
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max, 1);
  const x = (i: number) => pad.left + (i * (width - pad.left - pad.right)) / (points.length - 1);
  const y = (v: number) => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${height - pad.bottom} L${x(0).toFixed(1)},${height - pad.bottom} Z`;
  const shown = active ?? points.length - 1;
  const first = points[0]!;
  const last = points.at(-1)!;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${format(first.value)} on ${shortDate(first.at)} to ${format(last.value)} on ${shortDate(last.at)}`}
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id}-fill)`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={p.at}>
            <circle
              cx={x(i)}
              cy={y(p.value)}
              r={i === shown ? 4 : 2.5}
              fill={i === shown ? "var(--accent)" : "var(--surface)"}
              stroke="var(--accent)"
              strokeWidth="1.5"
            />
            {/* Generous invisible target: fingers are wider than 4 pixels. */}
            <rect
              x={x(i) - 12}
              y={0}
              width="24"
              height={height}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
              onClick={() => setActive(i)}
            />
          </g>
        ))}
        <text x={x(0)} y={height - 6} className="chart-axis" textAnchor="start">
          {shortDate(first.at)}
        </text>
        <text x={x(points.length - 1)} y={height - 6} className="chart-axis" textAnchor="end">
          {shortDate(last.at)}
        </text>
      </svg>
      <figcaption className="chart-caption">
        <strong>{full(points[shown]!.value)}</strong>
        <span className="muted"> · {shortDate(points[shown]!.at)}</span>
      </figcaption>
      <table className="visually-hidden">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.at}>
              <th scope="row">{shortDate(p.at)}</th>
              <td>{full(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
