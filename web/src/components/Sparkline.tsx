/** Small trend line with an area fill and an emphasised last point. Needs at least two points. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 320;
  const h = 72;
  const pad = 6;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (values.length - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values.length - 1;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      <polygon className="spark-area" points={`${x(0)},${h - pad} ${points.join(" ")} ${x(last)},${h - pad}`} />
      <polyline className="spark-line" points={points.join(" ")} />
      <circle className="spark-dot" cx={x(last)} cy={y(values[last]!)} r="4" />
    </svg>
  );
}
