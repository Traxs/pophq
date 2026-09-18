import { useEffect, useMemo, useState } from "react";
import type { RosterRow } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { change, compact, daysBetween, full, initials, relativeDay } from "../format";
import { useSession } from "../session";

const OVERDUE_DAYS = 30;
type SortKey = "name" | "rank" | "power" | "change" | "lastReport";
type Filter = "all" | "overdue" | "none";

const ageDays = (r: RosterRow) => (r.lastReportAt ? daysBetween(new Date(r.lastReportAt), new Date()) : Infinity);
const pct = (r: RosterRow) => (r.power !== null ? change(r.power, r.previousPower ?? undefined)?.percent : undefined);

const COMPARE: Record<SortKey, (a: RosterRow, b: RosterRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  rank: (a, b) => (b.rank ?? "").localeCompare(a.rank ?? "") || a.name.localeCompare(b.name),
  power: (a, b) => (b.power ?? -1) - (a.power ?? -1),
  change: (a, b) => (pct(b) ?? -Infinity) - (pct(a) ?? -Infinity),
  lastReport: (a, b) => ageDays(b) - ageDays(a),
};

export function Members() {
  const { api, isOfficer, dataVersion } = useSession();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("power");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isOfficer) return;
    api
      .roster()
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, dataVersion, attempt]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.playerId.includes(q))
      .filter((r) =>
        filter === "overdue" ? r.lastReportAt !== null && ageDays(r) >= OVERDUE_DAYS : filter === "none" ? r.lastReportAt === null : true,
      )
      .toSorted(COMPARE[sort]);
  }, [rows, query, filter, sort]);

  if (!isOfficer) {
    return (
      <section className="card empty">
        <h2>Officers only</h2>
        <p className="muted">The member overview is for R4 and R5.</p>
      </section>
    );
  }

  const total = rows?.reduce((s, r) => s + (r.power ?? 0), 0) ?? 0;
  const overdue = rows?.filter((r) => r.lastReportAt !== null && ageDays(r) >= OVERDUE_DAYS).length ?? 0;
  const noReport = rows?.filter((r) => r.lastReportAt === null).length ?? 0;

  const header = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={className} aria-sort={sort === key ? (key === "name" ? "ascending" : "descending") : "none"}>
      <button type="button" className="th-btn" onClick={() => setSort(key)}>
        {label}
        {sort === key && <span aria-hidden="true"> ▾</span>}
      </button>
    </th>
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Members</h1>
        <span className="muted">POP</span>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}

      <div className="tiles">
        <div className="card tile">
          <span className="tile-label">Members</span>
          <span className="tile-value">{rows ? rows.length : "–"}</span>
        </div>
        <div className="card tile">
          <span className="tile-label">Total power</span>
          <span className="tile-value">{rows ? compact(total) : "–"}</span>
        </div>
        <button type="button" className="card tile tile-warn" onClick={() => setFilter("overdue")}>
          <span className="tile-label">Overdue</span>
          <span className="tile-value">{rows ? overdue : "–"}</span>
        </button>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search name or Player ID"
          aria-label="Search members"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="segmented" role="radiogroup" aria-label="Filter">
          {(
            [
              ["all", "All"],
              ["overdue", `Overdue${overdue ? ` (${overdue})` : ""}`],
              ["none", `No report${noReport ? ` (${noReport})` : ""}`],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!rows && !error ? (
        <div className="card skeleton" style={{ height: 320 }} />
      ) : (
        <div className="card table-card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {header("name", "Member")}
                  {header("rank", "Rank")}
                  {header("power", "Power", "num")}
                  {header("change", "Change", "num")}
                  {header("lastReport", "Last report")}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const p = pct(r);
                  const age = ageDays(r);
                  return (
                    <tr key={r.playerId}>
                      <td>
                        <span className="member">
                          <span className="avatar" aria-hidden="true">
                            {initials(r.name)}
                          </span>
                          <span className="member-text">
                            <strong>{r.name}</strong>
                            <span className="muted small">{r.playerId}</span>
                          </span>
                        </span>
                      </td>
                      <td>{r.rank ?? "–"}</td>
                      <td className="num">{r.power !== null ? full(r.power) : "–"}</td>
                      <td className={`num ${p === undefined ? "" : p > 0 ? "delta-up" : p < 0 ? "delta-down" : ""}`}>
                        {p === undefined ? "–" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`}
                      </td>
                      <td>
                        {r.lastReportAt ? (
                          <span className={age >= OVERDUE_DAYS ? "badge badge-warn" : "badge"}>{relativeDay(r.lastReportAt)}</span>
                        ) : (
                          <span className="badge badge-none">never</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {visible.length === 0 && <p className="muted center table-empty">No members match.</p>}
        </div>
      )}
    </>
  );
}
