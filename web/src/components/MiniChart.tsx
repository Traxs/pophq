/**
 * A very small trend graph for a table cell: six trailing months, no axes.
 * Months with nothing to say are gaps, not zeros, so a quiet month never looks like a collapse.
 */
export function MiniChart({
  values,
  label,
  domain,
  midline = false,
}: {
  values: (number | null)[];
  label: string;
  /** Fixed scale, e.g. [0, 1] for a share. Without it the graph fits its own values. */
  domain?: [number, number];
  /** Faint line through the middle of a fixed scale, e.g. "half the commitments kept". */
  midline?: boolean;
}) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return <span className="muted">–</span>;

  const width = 64;
  const height = 20;
  const [min, max] = domain ?? [Math.min(...known), Math.max(...known)];
  const span = max - min || max || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  const last = known.at(-1)!;
  // On a fixed scale the value means something in itself (kept vs missed), so it carries colour.
  const stroke = domain ? (last >= (min + max) / 2 ? "var(--up)" : "var(--down)") : "var(--accent)";

  return (
    <svg className="mini" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
      {domain && midline && (
        <line x1="0" y1={y((min + max) / 2)} x2={width} y2={y((min + max) / 2)} className="mini-midline" />
      )}
      {values.map((v, i) => {
        const next = values[i + 1];
        if (v === null || next === undefined || next === null) return null;
        return (
          <line
            key={i}
            x1={i * step}
            y1={y(v)}
            x2={(i + 1) * step}
            y2={y(next)}
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        );
      })}
      {/* Points make single readings and gaps visible; a lone dot is honest about "one reading". */}
      {values.map((v, i) =>
        v === null ? null : <circle key={`p${i}`} cx={i * step} cy={y(v)} r={i === values.length - 1 ? 2 : 1.4} fill={stroke} />,
      )}
    </svg>
  );
}
