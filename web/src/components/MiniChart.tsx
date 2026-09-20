/**
 * A very small trend graph for a table cell: six trailing months, no axes.
 * Months with nothing to say are gaps, not zeros, so a quiet month never looks like a collapse.
 */
export function MiniChart({
  values,
  label,
  kind = "line",
}: {
  values: (number | null)[];
  label: string;
  /** "line" for numbers that grow, "bars" for a share between 0 and 1. */
  kind?: "line" | "bars";
}) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return <span className="muted">–</span>;
  // One reading is not a trend, but it is not nothing either: show it as a single point.
  const singleReading = kind === "line" && known.length === 1;

  const width = 64;
  const height = 20;
  const max = kind === "bars" ? 1 : Math.max(...known);
  const min = kind === "bars" ? 0 : Math.min(...known);
  const span = max - min || max || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);

  return (
    <svg className="mini" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
      {singleReading ? (
        <circle cx={width - 2} cy={height / 2} r="2.5" fill="var(--accent)" />
      ) : kind === "bars"
        ? values.map((v, i) =>
            v === null ? null : (
              <rect
                key={i}
                x={i * (width / values.length) + 1}
                y={y(v)}
                width={width / values.length - 2}
                height={Math.max(1, height - 1 - y(v))}
                // Below half means more missed than kept: worth seeing at a glance.
                fill={v >= 0.5 ? "var(--up)" : "var(--down)"}
              />
            ),
          )
        : values.map((v, i) => {
            const next = values[i + 1];
            if (v === null || next === undefined || next === null) return null;
            return (
              <line
                key={i}
                x1={i * step}
                y1={y(v)}
                x2={(i + 1) * step}
                y2={y(next)}
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            );
          })}
    </svg>
  );
}
