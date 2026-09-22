import { useCallback, useEffect, useState } from "react";
import type { Reports } from "./api";
import { toSeries, type PowerPoint } from "./powerReports";
import { useSession } from "./session";

export { toSeries, type PowerPoint } from "./powerReports";

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
