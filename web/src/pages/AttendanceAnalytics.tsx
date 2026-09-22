import { useEffect, useMemo, useState } from "react";
import type { EventKind, EventParticipationMetrics, ParticipationCategory } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { LineChart } from "../components/LineChart";
import { initials, relativeDay } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

const TYPES: { kind: EventKind; label: string }[] = [
  { kind: "foundry", label: "Foundry" },
  { kind: "svs", label: "SvS" },
  { kind: "koi", label: "KOI" },
  { kind: "fdt", label: "FDT" },
];

const CATEGORIES: { value: "all" | ParticipationCategory; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "never", label: "Never" },
  { value: "sometimes", label: "Sometimes" },
  { value: "always", label: "Always" },
  { value: "no_history", label: "No recorded attendance" },
];

const CATEGORY_LABEL: Record<ParticipationCategory, string> = {
  always: "Always",
  sometimes: "Sometimes",
  never: "Never",
  no_history: "No recorded attendance",
};

export function AttendanceAnalytics() {
  const { api, account, isOfficer, dataVersion } = useSession();
  const [kind, setKind] = useState<EventKind>("foundry");
  const [weeks, setWeeks] = useState(12);
  const [category, setCategory] = useState<"all" | ParticipationCategory>("all");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EventParticipationMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const allowed = isOfficer && (account?.rank === "R4" || account?.rank === "R5");

  useEffect(() => {
    if (!allowed) return;
    setData(null);
    api
      .eventParticipation(kind, weeks)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, allowed, kind, weeks, dataVersion, attempt]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.members
      .filter((member) => category === "all" || member.category === category)
      .filter((member) => !q || member.name.toLowerCase().includes(q) || member.playerId.includes(q))
      .toSorted((a, b) => (a.rate ?? -1) - (b.rate ?? -1) || a.name.localeCompare(b.name));
  }, [data, category, query]);

  if (!allowed) {
    return (
      <section className="card empty">
        <h2>R4 access</h2>
        <p className="muted">Alliance attendance analytics are available to R4 and R5 officers.</p>
      </section>
    );
  }

  const counts = data?.members.reduce(
    (result, member) => ({ ...result, [member.category]: result[member.category] + 1 }),
    { always: 0, sometimes: 0, never: 0, no_history: 0 } as Record<ParticipationCategory, number>,
  );
  const last = data?.points.at(-1);
  const percent = (value: number) => `${value.toFixed(1)}%`;

  return (
    <>
      <button type="button" className="back-link" onClick={() => navigate("/members")}>← Members</button>
      <div className="page-head attendance-page-head">
        <div>
          <h1 className="page-title">Event attendance</h1>
          <p className="muted">See which events each person consistently joins. Main and sub accounts are combined.</p>
        </div>
        <div className="segmented time-range" role="radiogroup" aria-label="Time range">
          {[4, 12, 26].map((value) => (
            <button key={value} type="button" role="radio" aria-checked={weeks === value} onClick={() => setWeeks(value)}>
              {value}w
            </button>
          ))}
        </div>
      </div>

      <div className="segmented event-type-tabs" role="radiogroup" aria-label="Event type">
        {TYPES.map((type) => (
          <button key={type.kind} type="button" role="radio" aria-checked={kind === type.kind} onClick={() => setKind(type.kind)}>
            {type.label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((value) => value + 1)} />}
      {!data && !error ? (
        <div className="card skeleton" style={{ height: 300 }} />
      ) : data ? (
        <>
          <div className="attendance-overview-grid">
            <section className="card attendance-trend-card">
              <div className="metric-card-head">
                <div>
                  <span className="section-label">Alliance attendance</span>
                  <strong className="metric-total">{last ? percent(last.value) : "–"}</strong>
                </div>
                <span className="muted small">{data.eventCount} tracked events</span>
              </div>
              <LineChart
                points={data.points}
                height={150}
                label={`${TYPES.find((type) => type.kind === kind)?.label} attendance week over week`}
                format={percent}
                detailFormat={percent}
              />
            </section>

            <div className="attendance-category-grid" aria-label="Participation groups">
              {(["never", "sometimes", "always", "no_history"] as ParticipationCategory[]).map((value) => (
                <button key={value} type="button" className="card attendance-category" onClick={() => setCategory(value)}>
                  <span className="tile-value">{counts?.[value] ?? 0}</span>
                  <span className="muted small">{CATEGORY_LABEL[value]}</span>
                </button>
              ))}
            </div>
          </div>

          <section className="attendance-members" aria-labelledby="attendance-members-title">
            <div className="roster-head">
              <div>
                <h2 id="attendance-members-title">Members</h2>
                <p className="muted small">Only explicit present or absent records are evaluated. Missing records are ignored.</p>
              </div>
            </div>
            <div className="roster-toolbar">
              <input
                type="search"
                className="search"
                placeholder="Search name or Player ID"
                aria-label="Search participation"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <label className="filter-select">
                <span className="visually-hidden">Filter participation</span>
                <select value={category} onChange={(event) => setCategory(event.target.value as "all" | ParticipationCategory)}>
                  {CATEGORIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}{option.value === "all" ? ` (${data.members.length})` : ` (${counts?.[option.value] ?? 0})`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="card participation-list">
              {visible.map((member) => (
                <button
                  key={member.playerId}
                  type="button"
                  className="participation-row"
                  onClick={() => navigate(`/members/${member.playerId}`)}
                >
                  <span className="member">
                    <span className="avatar" aria-hidden="true">{initials(member.name)}</span>
                    <span className="member-text">
                      <strong>{member.name}</strong>
                      <span className="muted small">{member.playerId}{member.rank ? ` · ${member.rank}` : ""}</span>
                      {(member.linkedAccounts?.length ?? 0) > 0 && (
                        <span className="muted small">
                          Includes {member.linkedAccounts!.map((account) => account.name).join(", ")}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="participation-numbers">
                    <strong>{member.rate === undefined ? "–" : percent(member.rate * 100)}</strong>
                    <span className="muted small">
                      {member.events === 0
                        ? "No eligible events"
                        : `${member.attended} of ${member.events}${member.lastAttendedAt ? ` · last ${relativeDay(member.lastAttendedAt)}` : ""}`}
                    </span>
                  </span>
                  <span className={`badge participation-${member.category}`}>{CATEGORY_LABEL[member.category]}</span>
                </button>
              ))}
              {visible.length === 0 && <p className="muted center table-empty">No members match.</p>}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
