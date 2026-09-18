import { useCallback, useEffect, useState } from "react";
import type { Report, Reports } from "./api";
import { useSession } from "./session";

export interface PowerPoint {
  reportId: string;
  effectiveAt: string;
  power: number;
  source: string;
}

export interface PowerData {
  reports: Reports | null;
  /** City power over time, oldest first, corrections applied. */
  series: PowerPoint[];
  latest: PowerPoint | undefined;
  previous: PowerPoint | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function toSeries(items: readonly Report[]): PowerPoint[] {
  const superseded = new Set(items.flatMap((r) => (r.supersedesReportId ? [r.supersedesReportId] : [])));
  return items
    .filter((r) => !superseded.has(r.reportId))
    .flatMap((r) => {
      const v = r.values.find((x) => x.metric === "city_power")?.value;
      return typeof v === "number"
        ? [{ reportId: r.reportId, effectiveAt: r.effectiveAt, power: v, source: r.source }]
        : [];
    })
    .toSorted((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.reportId.localeCompare(b.reportId));
}

export function usePower(): PowerData {
  const { api, account, dataVersion } = useSession();
  const [reports, setReports] = useState<Reports | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playerId = account?.playerId;

  const reload = useCallback(() => {
    if (!playerId) return;
    setLoading(true);
    api
      .reports(playerId)
      .then((r) => {
        setReports(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, playerId]);

  useEffect(() => {
    setReports(null);
    reload();
  }, [reload, dataVersion]);

  const series = reports ? toSeries(reports.items) : [];
  return {
    reports,
    series,
    latest: series.at(-1),
    previous: series.at(-2),
    loading,
    error,
    reload,
  };
}
