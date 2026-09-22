import { useEffect, useState } from "react";
import type { AllianceGrowth, Mover, StrengthMetric } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { LineChart } from "../components/LineChart";
import { compact, full, initials } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

const METRICS: { value: StrengthMetric; label: string }[] = [
  { value: "city_power", label: "City power" },
  { value: "foundry_strength", label: "Foundry strength" },
];

export function GrowthAnalytics({ metric }: { metric: StrengthMetric }) {
  const { api, isOfficer, dataVersion } = useSession();
  const [weeks, setWeeks] = useState(12);
  const [growth, setGrowth] = useState<AllianceGrowth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const label = METRICS.find((item) => item.value === metric)?.label ?? "Growth";

  useEffect(() => {
    if (!isOfficer) return;
    setGrowth(null);
    api
      .growth(weeks, metric, "all")
      .then((result) => {
        setGrowth(result);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, weeks, metric, dataVersion, attempt]);

  if (!isOfficer) {
    return (
      <section className="card empty">
        <h2>Officers only</h2>
        <p className="muted">Alliance growth analytics are available to officers.</p>
      </section>
    );
  }

  const last = growth?.points.at(-1);
  const first = growth?.points[0];
  const change = first && last && first.total > 0 ? ((last.total - first.total) / first.total) * 100 : undefined;

  return (
    <>
      <button type="button" className="back-link" onClick={() => navigate("/members")}>← Members</button>
      <div className="page-head attendance-page-head">
        <div>
          <h1 className="page-title">Growth analytics</h1>
          <p className="muted">See who is moving—and who is standing still—by percentage.</p>
        </div>
        <div className="segmented time-range" role="radiogroup" aria-label="Time range">
          {[4, 12, 26].map((value) => (
            <button key={value} type="button" role="radio" aria-checked={weeks === value} onClick={() => setWeeks(value)}>
              {value}w
            </button>
          ))}
        </div>
      </div>

      <div className="segmented event-type-tabs" role="radiogroup" aria-label="Strength metric">
        {METRICS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={metric === item.value}
            onClick={() => navigate(`/members/growth/${item.value}`)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((value) => value + 1)} />}
      {!growth && !error ? (
        <div className="card skeleton" style={{ height: 300 }} />
      ) : growth ? (
        <>
          <section className="card growth-detail-chart">
            <div className="metric-card-head">
              <div>
                <span className="section-label">Total alliance {label.toLowerCase()}</span>
                <strong className="metric-total">{last ? full(last.total) : "–"}</strong>
              </div>
              {change !== undefined && (
                <span className={`pill ${change >= 0 ? "pill-up" : "pill-down"}`}>
                  {change >= 0 ? "+" : ""}{change.toFixed(1)}%
                </span>
              )}
            </div>
            <LineChart
              points={growth.points.map((point) => ({ at: point.at, value: point.total }))}
              height={170}
              label={`Total alliance ${label.toLowerCase()} over time`}
            />
            <p className="muted small">
              {last ? `${last.members} accounts reporting · ${compact(last.average)} average` : "No reports yet"}
            </p>
          </section>

          <div className="growth-summary-grid">
            <div className="card tile"><span className="tile-value">{growth.gainers.length}</span><span className="muted small">Growing</span></div>
            <div className="card tile"><span className="tile-value">{growth.stalled.length}</span><span className="muted small">Not growing</span></div>
            <div className="card tile"><span className="tile-value">{growth.missing.length}</span><span className="muted small">Missing data</span></div>
          </div>

          <div className="growth-leaderboards">
            <GrowthList title="Top movers" note={`Biggest percentage increase over ${weeks} weeks`} movers={growth.gainers} />
            <GrowthList title="Not growing" note="Flat or declining, lowest percentage first" movers={growth.stalled} />
          </div>

          {growth.missing.length > 0 && (
            <section className="card missing-growth-card">
              <h2>Missing data</h2>
              <p className="muted small">No {label.toLowerCase()} report is available for these accounts.</p>
              <div className="missing-member-grid">
                {growth.missing.map((member) => (
                  <button key={member.playerId} type="button" onClick={() => navigate(`/members/${member.playerId}`)}>
                    <span className="avatar" aria-hidden="true">{initials(member.name)}</span>
                    <span><strong>{member.name}</strong><span className="muted small">{member.playerId}</span></span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}
    </>
  );
}

function GrowthList({ title, note, movers }: { title: string; note: string; movers: Mover[] }) {
  return (
    <section className="card growth-list-card">
      <div>
        <h2>{title}</h2>
        <p className="muted small">{note}</p>
      </div>
      {movers.length === 0 ? (
        <p className="muted">Nobody in this group.</p>
      ) : (
        <ol className="growth-list">
          {movers.map((mover, index) => (
            <li key={mover.playerId}>
              <button type="button" onClick={() => navigate(`/members/${mover.playerId}`)}>
                <span className="growth-rank">{index + 1}</span>
                <span className="member-text">
                  <strong>{mover.name}</strong>
                  <span className="muted small">{full(mover.from)} → {full(mover.to)}</span>
                </span>
                <span className={`pill ${mover.percent > 0 ? "pill-up" : mover.percent < 0 ? "pill-down" : ""}`}>
                  {mover.percent > 0 ? "+" : ""}{mover.percent.toFixed(1)}%
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
