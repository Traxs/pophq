import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type AllianceAttendanceGrowth,
  type AllianceGrowth,
  type RosterRow,
  type Seats,
  type StrengthMetric,
  type UnresolvedAccountSource,
} from "../api";
import { ErrorBanner } from "../components/Chrome";
import { InviteMemberForm } from "../components/InviteMember";
import { LineChart } from "../components/LineChart";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { compact, full, initials } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

type SortKey = "name" | "rank" | "foundry";
type Filter = "all" | "active" | "unknown" | "unlinked" | "noFoundry";
type RosterScope = "current" | "former";

const COMPARE: Record<SortKey, (a: RosterRow, b: RosterRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  rank: (a, b) => (b.rank ?? "").localeCompare(a.rank ?? "") || a.name.localeCompare(b.name),
  foundry: (a, b) => (b.foundryStrength ?? -1) - (a.foundryStrength ?? -1),
};

export function Members() {
  const { api, isOfficer, dataVersion, dataChanged } = useSession();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [seats, setSeats] = useState<Seats | null>(null);
  const [unresolvedSources, setUnresolvedSources] = useState<UnresolvedAccountSource[]>([]);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<RosterScope>("current");
  const [sort, setSort] = useState<SortKey>("foundry");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isOfficer) return;
    api
      .roster()
      .then((r) => {
        setRows(r.items);
        setSeats(r.seats);
        setUnresolvedSources(r.unresolvedSources ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, dataVersion, attempt]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => scope === "former" ? r.status === "transferred_out" : r.status !== "transferred_out" && r.status !== "archived")
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.playerId.includes(q) || (r.aliases ?? []).some((alias) => alias.toLowerCase().includes(q)))
      .filter((r) => {
        if (filter === "noFoundry") return r.foundryStrength === null;
        if (filter === "unlinked") return !r.hasLogin;
        if (scope === "current" && filter !== "all") return r.status === filter;
        return true;
      })
      .toSorted(COMPARE[sort]);
  }, [rows, query, filter, scope, sort]);

  if (!isOfficer) {
    return (
      <section className="card empty">
        <h2>Officers only</h2>
        <p className="muted">The member overview is for officers.</p>
      </section>
    );
  }

  const counts = rows?.reduce(
    (result, row) => ({
      ...result,
      [row.status]: (result[row.status] ?? 0) + 1,
      noFoundry: (result.noFoundry ?? 0) + (row.foundryStrength === null ? 1 : 0),
      unlinked: (result.unlinked ?? 0) + (!row.hasLogin ? 1 : 0),
    }),
    { active: 0, unknown: 0, transferred_out: 0, guest: 0, unlinked: 0, noFoundry: 0 } as Record<string, number>,
  );
  const currentCount = rows?.filter((row) => row.status !== "transferred_out" && row.status !== "archived").length ?? 0;
  const formerCount = counts?.transferred_out ?? 0;

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
        <button type="button" className="btn btn-primary btn-small" onClick={() => setInviting(true)}>
          Invite
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}

      <AllianceCharts />

      <Sheet open={inviting} title="Invite a member" onClose={() => setInviting(false)}>
        <InviteMemberForm
          candidates={(rows ?? []).filter((row) => row.status !== "transferred_out" && row.status !== "archived")}
          onChanged={dataChanged}
          onClose={() => setInviting(false)}
        />
      </Sheet>

      <section className="roster-section" aria-labelledby="roster-title">
        <div className="roster-head">
          <div>
            <h2 id="roster-title">{scope === "current" ? "Active roster" : "Former members"}</h2>
            <p className="muted small">
              {rows ? scope === "current" ? `${currentCount} current alliance accounts` : `${formerCount} former alliance accounts` : "Loading accounts…"}
              {scope === "current" && seats && ` · ${seats.used} of ${seats.cap} sign-in seats used`}
            </p>
          </div>
        </div>
        <div className="segmented roster-scope" role="tablist" aria-label="Roster membership">
          <button type="button" role="tab" aria-selected={scope === "current"} className={scope === "current" ? "active" : ""} onClick={() => { setScope("current"); setFilter("all"); }}>
            Active roster <span>{currentCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={scope === "former"} className={scope === "former" ? "active" : ""} onClick={() => { setScope("former"); setFilter("all"); }}>
            Former members <span>{formerCount}</span>
          </button>
        </div>
        <div className="roster-toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search name or Player ID"
            aria-label="Search members"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {scope === "current" && <label className="filter-select">
            <span className="visually-hidden">Filter roster</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All current accounts ({currentCount})</option>
              <option value="active">Confirmed members ({counts?.active ?? 0})</option>
              <option value="unknown">Unconfirmed ({counts?.unknown ?? 0})</option>
              <option value="unlinked">No login ({counts?.unlinked ?? 0})</option>
              <option value="noFoundry">Missing Foundry strength ({counts?.noFoundry ?? 0})</option>
            </select>
          </label>}
        </div>

        {unresolvedSources.length > 0 && (
          <details className="card unresolved-account-sources">
            <summary>
              <span>Unresolved source records</span>
              <span className="badge badge-warn">{unresolvedSources.length} need an exact Player ID</span>
            </summary>
            <p className="muted small">
              These source rows are preserved, but are not accounts and have no login. Link them only after the exact Player ID is verified.
            </p>
            <ul className="unresolved-account-list">
              {unresolvedSources.map((source) => (
                <li key={source.recordId}>
                  <strong>{source.suppliedName}</strong>
                  <span className="muted small">Source: {source.sourceId}{source.eventId ? ` · Event ${source.eventId}` : ""}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

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
                  <th scope="col">Membership</th>
                  {header("foundry", "Foundry strength", "num")}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  return (
                    <tr key={r.playerId}>
                      <td>
                        <span className="member">
                          <span className="avatar" aria-hidden="true">
                            {initials(r.name)}
                          </span>
                          <span className="member-text">
                            <button type="button" className="member-link" onClick={() => navigate(`/members/${r.playerId}`)}>
                              {r.name}
                            </button>
                            <span className="muted small roster-account-meta">{r.playerId}{!r.hasLogin && <span className="badge">No login</span>}</span>
                          </span>
                        </span>
                      </td>
                      <td>{isOfficer ? <RankPicker row={r} /> : (r.rank ?? "–")}</td>
                      <td>
                        <StatusPicker row={r} />
                      </td>
                      <td className="num roster-strength">{r.foundryStrength !== null ? full(r.foundryStrength) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
            {visible.length === 0 && <p className="muted center table-empty">{scope === "former" ? "No former members match." : "No members match."}</p>}
          </div>
        )}
      </section>
    </>
  );
}

const RANKS = ["R1", "R2", "R3", "R4", "R5"] as const;

/**
 * Membership, as an officer would say it. "Guest" is missing on purpose: a guest belongs to
 * another alliance, so it is set together with the alliance rather than on its own.
 */
const MEMBERSHIP = [
  { value: "active", label: "Member" },
  { value: "unknown", label: "Unconfirmed" },
] as const;

function StatusPicker({ row }: { row: RosterRow }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // A guest's membership is bound up with their alliance, so it is shown but not changed here.
  if (row.status === "guest") return <span className="badge">Guest · {row.alliance}</span>;
  // Departures affect every account and the shared login, so they are managed on the profile.
  if (row.status === "transferred_out") return <span className="badge badge-none">Former member</span>;

  const change = async (status: string) => {
    setSaving(true);
    try {
      await api.updateAccount(row.playerId, { status: status as "active" });
      toast(`${row.name}: ${MEMBERSHIP.find((m) => m.value === status)?.label ?? status}`);
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      aria-label={`${row.name}'s membership`}
      className="inline-select"
      value={row.status}
      disabled={saving}
      onChange={(e) => void change(e.target.value)}
    >
      {MEMBERSHIP.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Rank, set where an officer is already looking. Most of the roster arrived from an import with
 * no rank at all, and a form per member would mean ninety-odd round trips.
 */
function RankPicker({ row }: { row: RosterRow }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const change = async (rank: string) => {
    setSaving(true);
    try {
      await api.updateAccount(row.playerId, { rank });
      toast(rank ? `${row.name} is ${rank}` : `${row.name}'s rank cleared`);
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      aria-label={`${row.name}'s rank`}
      className="inline-select"
      value={row.rank ?? ""}
      disabled={saving}
      onChange={(e) => void change(e.target.value)}
    >
      <option value="">–</option>
      {RANKS.map((rank) => (
        <option key={rank} value={rank}>
          {rank}
        </option>
      ))}
    </select>
  );
}

function AllianceCharts() {
  const { account } = useSession();
  const [weeks, setWeeks] = useState(12);
  const canViewAttendance = account?.rank === "R4" || account?.rank === "R5";
  return (
    <section className="alliance-growth" aria-labelledby="alliance-growth-title">
      <div className="alliance-growth-head">
        <div>
          <h2 id="alliance-growth-title">Alliance growth</h2>
          <p className="muted small">Every current alliance account with a report is included.</p>
        </div>
        <div className="segmented time-range" role="radiogroup" aria-label="Time range">
          {[4, 12, 26].map((w) => (
            <button key={w} type="button" role="radio" aria-checked={weeks === w} onClick={() => setWeeks(w)}>
              {w}w
            </button>
          ))}
        </div>
      </div>
      <div className="alliance-chart-grid">
        <AllianceChart metric="city_power" weeks={weeks} />
        <AllianceChart metric="foundry_strength" weeks={weeks} />
        {canViewAttendance && <AllianceAttendanceChart weeks={weeks} />}
      </div>
    </section>
  );
}

function AllianceAttendanceChart({ weeks }: { weeks: number }) {
  const { api, dataVersion } = useSession();
  const [growth, setGrowth] = useState<AllianceAttendanceGrowth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api
      .attendanceGrowth(weeks)
      .then((result) => {
        setGrowth(result);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, weeks, dataVersion, attempt]);

  if (error) return <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!growth) return <div className="card skeleton alliance-chart-card" />;

  const last = growth.points.at(-1);
  const observed = growth.points.filter((point) => point.events > 0);
  const change = observed.length > 1 ? observed.at(-1)!.value - observed[0]!.value : undefined;
  const percent = (value: number) => `${value.toFixed(1)}%`;

  return (
    <section
      className="card chart-card alliance-chart-card attendance-chart-link"
      aria-label="Alliance event attendance. Open detailed analytics."
      role="link"
      tabIndex={0}
      onClick={() => navigate("/members/attendance")}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") navigate("/members/attendance");
      }}
    >
      <div className="metric-card-head">
        <div>
          <span className="section-label">Event attendance</span>
          <strong className="metric-total">{last ? percent(last.value) : "–"}</strong>
        </div>
        {change !== undefined && change !== 0 && (
          <span className={`pill ${change > 0 ? "pill-up" : "pill-down"}`}>
            {change > 0 ? "+" : ""}{change.toFixed(1)} pts
          </span>
        )}
      </div>
      <LineChart
        points={growth.points}
        height={140}
        label="Average alliance event attendance week over week"
        format={percent}
        detailFormat={percent}
      />
      <p className="muted small">
        {last?.events
          ? `${last.events} event${last.events === 1 ? "" : "s"} this week · ${last.records} checked records`
          : "No event this week · carrying the last attendance rate"}
      </p>
      <span className="attendance-chart-cta">View by event and member →</span>
    </section>
  );
}

/** One alliance-wide metric. Both cards deliberately use the same cohort and time range. */
function AllianceChart({ metric, weeks }: { metric: StrengthMetric; weeks: number }) {
  const { api, dataVersion } = useSession();
  const [growth, setGrowth] = useState<AllianceGrowth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api
      .growth(weeks, metric, "all")
      .then((g) => {
        setGrowth(g);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, weeks, metric, dataVersion, attempt]);

  if (error) return <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!growth) return <div className="card skeleton alliance-chart-card" />;

  const last = growth.points.at(-1);
  const first = growth.points[0];
  const change = first && last && first.total > 0 ? ((last.total - first.total) / first.total) * 100 : undefined;

  return (
    <section
      className="card chart-card alliance-chart-card attendance-chart-link"
      aria-label={`${metric === "foundry_strength" ? "Foundry strength" : "City power"}. Open growth analytics.`}
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/members/growth/${metric}`)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") navigate(`/members/growth/${metric}`);
      }}
    >
      <div className="metric-card-head">
        <div>
          <span className="section-label">{metric === "foundry_strength" ? "Foundry strength" : "City power"}</span>
          <strong className="metric-total">{last ? full(last.total) : "–"}</strong>
        </div>
        {change !== undefined && (
          <span className={`pill ${change >= 0 ? "pill-up" : "pill-down"}`}>
            {change >= 0 ? "+" : ""}{change.toFixed(1)}%
          </span>
        )}
      </div>

      <LineChart
        points={growth.points.map((p) => ({ at: p.at, value: p.total }))}
        height={140}
        label={`Total alliance ${metric === "foundry_strength" ? "Foundry strength" : "city power"} over time`}
      />
      <p className="muted small">
        {last ? `${last.members} accounts reporting · ${compact(last.average)} average` : "No reports yet"}
        {growth.missing.length > 0 && ` · ${growth.missing.length} missing`}
      </p>
      <span className="attendance-chart-cta">View movers and non-movers →</span>
    </section>
  );
}
