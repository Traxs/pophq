// Alliance metrics for the officer charts (MET-01). Pure functions: the routes fetch the
// reports, these decide what the numbers mean, so the rules are testable and explicit.
import { currentValues, type MetricName, type Report } from "./measurements.js";

export interface AccountSeries {
  playerId: string;
  name: string;
  /** Effective time and value of every non-superseded report of one metric, any order. */
  points: { at: string; value: number }[];
}

export interface GrowthPoint {
  /** End of the bucket (inclusive), ISO date-time. */
  at: string;
  /** Sum over members who had a value by then. */
  total: number;
  average: number;
  /** How many members contributed a value. */
  members: number;
}

export interface Mover {
  playerId: string;
  name: string;
  from: number;
  to: number;
  change: number;
  percent: number;
}

export interface AllianceGrowth {
  metric: MetricName;
  points: GrowthPoint[];
  /** Biggest growers over the window, strongest first. */
  gainers: Mover[];
  /** Members whose value did not grow over the window. */
  stalled: Mover[];
  /** Members with no value at all in the window. */
  missing: { playerId: string; name: string }[];
}

/** The value of a series at a moment: the latest point at or before it. */
export function valueAt(points: readonly { at: string; value: number }[], at: string): number | undefined {
  let best: { at: string; value: number } | undefined;
  for (const p of points) {
    if (p.at <= at && (!best || p.at > best.at)) best = p;
  }
  return best?.value;
}

/** Bucket ends, oldest first: `count` steps of `stepDays`, the last one ending at `now`. */
export function buckets(now: Date, count = 12, stepDays = 7): string[] {
  const step = stepDays * 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() - (count - 1 - i) * step).toISOString());
}

export function allianceGrowth(metric: MetricName, series: readonly AccountSeries[], ends: readonly string[]): AllianceGrowth {
  const points: GrowthPoint[] = ends.map((at) => {
    const values = series.flatMap((s) => {
      const v = valueAt(s.points, at);
      return v === undefined ? [] : [v];
    });
    const total = values.reduce((sum, v) => sum + v, 0);
    return { at, total, average: values.length ? Math.round(total / values.length) : 0, members: values.length };
  });

  const first = ends[0];
  const last = ends.at(-1);
  const movers: Mover[] = [];
  const missing: { playerId: string; name: string }[] = [];
  for (const s of series) {
    const to = last === undefined ? undefined : valueAt(s.points, last);
    if (to === undefined) {
      missing.push({ playerId: s.playerId, name: s.name });
      continue;
    }
    // Without a value at the start, compare against this member's first known value instead,
    // so someone who joined mid-window still shows their growth.
    const from =
      (first === undefined ? undefined : valueAt(s.points, first)) ??
      s.points.toSorted((a, b) => a.at.localeCompare(b.at))[0]?.value;
    if (from === undefined) continue;
    const change = to - from;
    movers.push({
      playerId: s.playerId,
      name: s.name,
      from,
      to,
      change,
      percent: from === 0 ? 0 : Number(((change / from) * 100).toFixed(1)),
    });
  }

  return {
    metric,
    points,
    gainers: movers.filter((m) => m.change > 0).toSorted((a, b) => b.percent - a.percent),
    stalled: movers.filter((m) => m.change <= 0).toSorted((a, b) => a.percent - b.percent),
    missing,
  };
}

/** Non-superseded points of one metric from an account's reports. */
export function seriesOf(reports: readonly Report[], metric: MetricName): { at: string; value: number }[] {
  const superseded = new Set(reports.flatMap((r) => (r.supersedesReportId ? [r.supersedesReportId] : [])));
  return reports
    .filter((r) => !superseded.has(r.reportId))
    .flatMap((r) => {
      const value = r.values.find((v) => v.metric === metric)?.value;
      return typeof value === "number" ? [{ at: r.effectiveAt, value }] : [];
    })
    .toSorted((a, b) => a.at.localeCompare(b.at));
}

/** Current value of one metric, after corrections. */
export const currentOf = (reports: readonly Report[], metric: MetricName): number | undefined => {
  const value = currentValues(reports)[metric]?.value;
  return typeof value === "number" ? value : undefined;
};
