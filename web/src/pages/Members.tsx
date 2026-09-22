import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type AllianceGrowth, type InviteResult, type RosterRow, type Seats, type StrengthMetric } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { LineChart } from "../components/LineChart";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { change, compact, daysBetween, full, initials, relativeDay } from "../format";
import { summarise } from "../invites";
import { isReportOverdue, isValidEmail, isValidGameName, isValidPlayerId } from "../rules";
import { useSession } from "../session";

type SortKey = "name" | "rank" | "power" | "change" | "lastReport" | "foundry" | "lastFoundry" | "attendance";
type View = "foundry" | "city";
type Filter = "all" | "overdue" | "none" | "noFoundry" | "noAttendance";

const ageDays = (at: string | null) => (at ? daysBetween(new Date(at), new Date()) : Infinity);
const pct = (r: RosterRow) => (r.power !== null ? change(r.power, r.previousPower ?? undefined)?.percent : undefined);
const attendanceRate = (r: RosterRow) => r.attendance.rate ?? -1;

const COMPARE: Record<SortKey, (a: RosterRow, b: RosterRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  rank: (a, b) => (b.rank ?? "").localeCompare(a.rank ?? "") || a.name.localeCompare(b.name),
  power: (a, b) => (b.power ?? -1) - (a.power ?? -1),
  foundry: (a, b) => (b.foundryStrength ?? -1) - (a.foundryStrength ?? -1),
  attendance: (a, b) => attendanceRate(b) - attendanceRate(a) || b.attendance.sample - a.attendance.sample,
  change: (a, b) => (pct(b) ?? -Infinity) - (pct(a) ?? -Infinity),
  lastReport: (a, b) => ageDays(b.lastReportAt) - ageDays(a.lastReportAt),
  lastFoundry: (a, b) => ageDays(b.lastFoundryReportAt) - ageDays(a.lastFoundryReportAt),
};

export function Members() {
  const { api, isOfficer, dataVersion, dataChanged } = useSession();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [seats, setSeats] = useState<Seats | null>(null);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("foundry");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("foundry");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isOfficer) return;
    api
      .roster()
      .then((r) => {
        setRows(r.items);
        setSeats(r.seats);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, dataVersion, attempt]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.playerId.includes(q))
      .filter((r) => {
        if (filter === "overdue") return isReportOverdue(r.lastReportAt);
        if (filter === "none") return r.lastReportAt === null;
        if (filter === "noFoundry") return r.foundryStrength === null;
        if (filter === "noAttendance") return r.attendance.sample === 0;
        return true;
      })
      .toSorted(COMPARE[sort]);
  }, [rows, query, filter, sort]);

  if (!isOfficer) {
    return (
      <section className="card empty">
        <h2>Officers only</h2>
        <p className="muted">The member overview is for officers.</p>
      </section>
    );
  }

  const total = rows?.reduce((s, r) => s + (r.power ?? 0), 0) ?? 0;
  // Overdue includes members who never reported; "No report" is the subset without any report.
  const overdue = rows?.filter((r) => isReportOverdue(r.lastReportAt)).length ?? 0;
  const noReport = rows?.filter((r) => r.lastReportAt === null).length ?? 0;
  const foundryReported = rows?.filter((r) => r.foundryStrength !== null).length ?? 0;
  const noFoundry = (rows?.length ?? 0) - foundryReported;
  const attendanceTracked = rows?.filter((r) => r.attendance.sample > 0).length ?? 0;
  const noAttendance = (rows?.length ?? 0) - attendanceTracked;

  const changeView = (next: View) => {
    setView(next);
    setFilter("all");
    setSort(next === "foundry" ? "foundry" : "power");
  };

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

      <div className="tiles">
        <div className="card tile">
          <span className="tile-label">Members</span>
          <span className="tile-value">{rows ? rows.length : "–"}</span>
        </div>
        {view === "foundry" ? (
          <>
            <button type="button" className="card tile" onClick={() => setFilter(noFoundry ? "noFoundry" : "all")}>
              <span className="tile-label">Foundry strength</span>
              <span className="tile-value">{rows ? `${foundryReported}/${rows.length}` : "–"}</span>
            </button>
            <button type="button" className="card tile" onClick={() => setFilter(noAttendance ? "noAttendance" : "all")}>
              <span className="tile-label">Attendance tracked</span>
              <span className="tile-value">{rows ? `${attendanceTracked}/${rows.length}` : "–"}</span>
            </button>
          </>
        ) : (
          <>
            <div className="card tile">
              <span className="tile-label">Total city power</span>
              <span className="tile-value">{rows ? compact(total) : "–"}</span>
            </div>
            <button type="button" className="card tile tile-warn" onClick={() => setFilter("overdue")}>
              <span className="tile-label">Power overdue</span>
              <span className="tile-value">{rows ? overdue : "–"}</span>
            </button>
          </>
        )}
      </div>

      <AllianceChart key={view} metric={view === "foundry" ? "foundry_strength" : "city_power"} />

      {seats && (
        <p className="muted small">
          {seats.used} of {seats.cap} sign-in seats used. An alt account doesn't use an extra seat.
        </p>
      )}

      <Sheet open={inviting} title="Invite a member" onClose={() => setInviting(false)}>
        <InviteForm
          onDone={() => {
            setInviting(false);
            dataChanged();
          }}
        />
      </Sheet>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search name or Player ID"
          aria-label="Search members"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="segmented" role="radiogroup" aria-label="Member data">
          <button type="button" role="radio" aria-checked={view === "foundry"} onClick={() => changeView("foundry")}>
            Foundry & attendance
          </button>
          <button type="button" role="radio" aria-checked={view === "city"} onClick={() => changeView("city")}>
            City power
          </button>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Filter">
          {(view === "foundry"
            ? ([
                ["all", "All"],
                ["noFoundry", `Missing strength${noFoundry ? ` (${noFoundry})` : ""}`],
                ["noAttendance", `No attendance${noAttendance ? ` (${noAttendance})` : ""}`],
              ] as [Filter, string][])
            : ([
                ["all", "All"],
                ["overdue", `Overdue${overdue ? ` (${overdue})` : ""}`],
                ["none", `No power${noReport ? ` (${noReport})` : ""}`],
              ] as [Filter, string][])
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
                  {isOfficer && <th scope="col">Membership</th>}
                  {view === "foundry" ? (
                    <>
                      {header("foundry", "Foundry strength", "num")}
                      {header("lastFoundry", "Strength report")}
                      {header("attendance", "Attendance")}
                    </>
                  ) : (
                    <>
                      {header("power", "City power", "num")}
                      {header("change", "Change", "num")}
                      {header("lastReport", "Power report")}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const p = pct(r);
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
                      <td>{isOfficer ? <RankPicker row={r} /> : (r.rank ?? "–")}</td>
                      {isOfficer && (
                        <td>
                          <StatusPicker row={r} />
                        </td>
                      )}
                      {view === "foundry" ? (
                        <>
                          <td className="num">{r.foundryStrength !== null ? full(r.foundryStrength) : "–"}</td>
                          <td>
                            {r.lastFoundryReportAt ? (
                              <span className="badge">{relativeDay(r.lastFoundryReportAt)}</span>
                            ) : (
                              <span className="badge badge-none">never</span>
                            )}
                          </td>
                          <td>
                            {r.attendance.rate === undefined ? (
                              <span className="badge badge-none">not tracked</span>
                            ) : (
                              <span className="attendance-summary">
                                <strong>{Math.round(r.attendance.rate * 100)}%</strong>
                                <span className="muted small">{r.attendance.kept}/{r.attendance.sample} present</span>
                              </span>
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="num">{r.power !== null ? full(r.power) : "–"}</td>
                          <td className={`num ${p === undefined ? "" : p > 0 ? "delta-up" : p < 0 ? "delta-down" : ""}`}>
                            {p === undefined ? "–" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`}
                          </td>
                          <td>
                            {r.lastReportAt ? (
                              <span className={isReportOverdue(r.lastReportAt) ? "badge badge-warn" : "badge"}>{relativeDay(r.lastReportAt)}</span>
                            ) : (
                              <span className="badge badge-none">never</span>
                            )}
                          </td>
                        </>
                      )}
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

const RANKS = ["R1", "R2", "R3", "R4", "R5"] as const;

/**
 * Membership, as an officer would say it. "Guest" is missing on purpose: a guest belongs to
 * another alliance, so it is set together with the alliance rather than on its own.
 */
const MEMBERSHIP = [
  { value: "active", label: "Member" },
  { value: "unknown", label: "Unconfirmed" },
  { value: "transferred_out", label: "Left" },
] as const;

function StatusPicker({ row }: { row: RosterRow }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // A guest's membership is bound up with their alliance, so it is shown but not changed here.
  if (row.status === "guest") return <span className="badge">Guest · {row.alliance}</span>;

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

/** Officers invite people: creates the login, the game account and the link (P4.1). */
function InviteForm({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [name, setName] = useState("");
  const [rank, setRank] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const emailBad = email.trim() !== "" && !isValidEmail(email);
  const playerIdBad = playerId.trim() !== "" && !isValidPlayerId(playerId);
  const nameBad = name.trim() !== "" && !isValidGameName(name);
  const ready = isValidPlayerId(playerId) && isValidGameName(name) && !emailBad;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) {
      setTouched({ email: true, playerId: true, name: true });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res: InviteResult = await api.invite({
        ...(email.trim() ? { email: email.trim() } : {}),
        playerId: playerId.trim(),
        name: name.trim(),
        ...(rank ? { rank } : {}),
      });
      toast(summarise(res));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't invite. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="i-email">Email (optional)</label>
        <input
          id="i-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          placeholder="name@example.com"
          aria-invalid={emailBad && touched.email}
        />
        <span className="hint">
          They sign in with a code sent to this address. Leave empty to add a game account without a login.
        </span>
        {emailBad && touched.email && (
          <span className="field-error" role="alert">
            Enter a valid email address.
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="i-player">Player ID</label>
        <input
          id="i-player"
          inputMode="numeric"
          autoComplete="off"
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => setTouched((t) => ({ ...t, playerId: true }))}
          placeholder="410691488"
          aria-invalid={playerIdBad && touched.playerId}
        />
        <span className="hint">From their in-game profile.</span>
        {playerIdBad && touched.playerId && (
          <span className="field-error" role="alert">
            Player IDs are 5 to 15 digits.
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="i-name">Game name</label>
        <input
          id="i-name"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          placeholder="Frostbite"
          aria-invalid={nameBad && touched.name}
        />
        {nameBad && touched.name && (
          <span className="field-error" role="alert">
            Use 2 to 30 characters.
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="i-rank">Rank</label>
        <select id="i-rank" value={rank} onChange={(e) => setRank(e.target.value)}>
          <option value="">Not set</option>
          {["R1", "R2", "R3", "R4", "R5"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !ready}>
        {busy ? "Inviting…" : "Invite"}
      </button>
    </form>
  );
}

/** Alliance growth over time with the movers behind it (MET-01, officers only). */
function AllianceChart({ metric }: { metric: StrengthMetric }) {
  const { api, dataVersion } = useSession();
  const [growth, setGrowth] = useState<AllianceGrowth | null>(null);
  const [weeks, setWeeks] = useState(12);
  // Historical imports are alliance data even before every account has a confirmed membership
  // status. Foundry totals therefore include them by default; city-power totals stay conservative.
  const [cohort, setCohort] = useState<"members" | "all">(metric === "foundry_strength" ? "all" : "members");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .growth(weeks, metric, cohort)
      .then((g) => {
        setGrowth(g);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, weeks, metric, cohort, dataVersion]);

  if (error) return <ErrorBanner message={error} onRetry={() => setWeeks((w) => w)} />;
  if (!growth) return <div className="card skeleton" style={{ height: 160 }} />;

  const last = growth.points.at(-1);
  const first = growth.points[0];
  const change = first && last && first.total > 0 ? ((last.total - first.total) / first.total) * 100 : undefined;

  return (
    <section className="card stack" aria-labelledby="growth-title">
      <div className="event-head">
        <h2 id="growth-title" className="section-label">
          Alliance {metric === "foundry_strength" ? "Foundry strength" : "power"}
        </h2>
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {[4, 12, 26].map((w) => (
            <button key={w} type="button" role="radio" aria-checked={weeks === w} onClick={() => setWeeks(w)}>
              {w}w
            </button>
          ))}
        </div>
      </div>

      <LineChart
        points={growth.points.map((p) => ({ at: p.at, value: p.total }))}
        label={`Total alliance ${metric === "foundry_strength" ? "Foundry strength" : "power"} over time`}
      />
      <p className="muted small">
        {last ? `${compact(last.total)} across ${last.members} members` : "No data yet"}
        {change !== undefined && ` · ${change >= 0 ? "+" : ""}${change.toFixed(1)}% over ${weeks} weeks`}
      </p>

      {growth.gainers.length > 0 && (
        <>
          <h3 className="section-label">Top growth</h3>
          <ul className="movers">
            {growth.gainers.slice(0, 5).map((m) => (
              <li key={m.playerId} className="mover">
                <span>{m.name}</span>
                <span className="pill pill-up">+{m.percent}%</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(growth.stalled.length > 0 || growth.missing.length > 0) && (
        <p className="muted small">
          {growth.stalled.length > 0 && `${growth.stalled.length} not growing`}
          {growth.stalled.length > 0 && growth.missing.length > 0 && " · "}
          {growth.missing.length > 0 && `${growth.missing.length} without any report`}
        </p>
      )}

      {growth.unknownMembership > 0 && (
        <button type="button" className="text-btn" onClick={() => setCohort(cohort === "all" ? "members" : "all")}>
          {cohort === "all"
            ? `Including ${growth.unknownMembership} imported alliance accounts — confirmed members only`
            : `${growth.unknownMembership} imported alliance accounts are not counted — include them`}
        </button>
      )}
    </section>
  );
}
