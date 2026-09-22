import type { Report } from "./api";

export interface PowerPoint {
  reportId: string;
  effectiveAt: string;
  power: number;
  source: string;
}

/** City-power points after soft deletes and corrections are resolved. */
export function toSeries(items: readonly Report[]): PowerPoint[] {
  const visible = items.filter((report) => !report.ignoredAt);
  const superseded = new Set(visible.flatMap((report) => (report.supersedesReportId ? [report.supersedesReportId] : [])));
  return visible
    .filter((report) => !superseded.has(report.reportId))
    .flatMap((report) => {
      const value = report.values.find((measurement) => measurement.metric === "city_power")?.value;
      return typeof value === "number"
        ? [{ reportId: report.reportId, effectiveAt: report.effectiveAt, power: value, source: report.source }]
        : [];
    })
    .toSorted((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.reportId.localeCompare(b.reportId));
}
