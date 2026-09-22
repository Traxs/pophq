import { useEffect, useState } from "react";
import type { Reports, RosterRow } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { full, initials, relativeDay, shortDate } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

const METRIC_LABELS: Record<string, string> = {
  city_power: "City power",
  foundry_strength: "Foundry strength",
  furnace: "Furnace",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Member",
  unknown: "Unconfirmed",
  transferred_out: "Former member",
  guest: "Guest",
};

const OUTCOME_LABELS: Record<string, string> = {
  attended: "Participated",
  no_show: "No-show",
  unregistered: "Did not answer",
  excused: "Excused",
  not_counted: "Not counted",
};

export function MemberPage({ playerId }: { playerId: string }) {
  const { api, isOfficer, dataVersion } = useSession();
  const [row, setRow] = useState<RosterRow | null | undefined>(undefined);
  const [reports, setReports] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isOfficer) return;
    Promise.all([api.roster(), api.reports(playerId)])
      .then(([roster, reportHistory]) => {
        setRow(roster.items.find((item) => item.playerId === playerId) ?? null);
        setReports(reportHistory);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, playerId, dataVersion, attempt]);

  if (!isOfficer) {
    return (
      <section className="card empty">
        <h2>Officers only</h2>
        <p className="muted">Member details are visible to officers.</p>
      </section>
    );
  }

  if (error) return <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (row === undefined) return <div className="card skeleton" style={{ height: 320 }} />;
  if (row === null) {
    return (
      <section className="card empty">
        <h2>Member not found</h2>
        <button type="button" className="text-btn" onClick={() => navigate("/members")}>Back to roster</button>
      </section>
    );
  }

  const participation = row.attendance;

  return (
    <>
      <button type="button" className="back-link" onClick={() => navigate("/members")}>← Roster</button>
      <header className="member-profile-head">
        <span className="avatar avatar-large" aria-hidden="true">{initials(row.name)}</span>
        <div>
          <h1 className="page-title">{row.name}</h1>
          <p className="muted">{row.playerId} · {row.rank ?? "No rank"} · {STATUS_LABELS[row.status] ?? row.status}</p>
        </div>
      </header>

      <div className="member-metric-grid">
        <section className="card member-metric">
          <span className="section-label">City power</span>
          <strong>{row.power === null ? "–" : full(row.power)}</strong>
          <span className="muted small">{row.lastReportAt ? `Reported ${relativeDay(row.lastReportAt)}` : "No report"}</span>
        </section>
        <section className="card member-metric">
          <span className="section-label">Foundry strength</span>
          <strong>{row.foundryStrength === null ? "–" : full(row.foundryStrength)}</strong>
          <span className="muted small">{row.lastFoundryReportAt ? `Reported ${relativeDay(row.lastFoundryReportAt)}` : "No report"}</span>
        </section>
        <section className="card member-metric">
          <span className="section-label">Participation</span>
          <strong>{participation.rate === undefined ? "–" : `${Math.round(participation.rate * 100)}%`}</strong>
          <span className="muted small">
            {participation.sample === 0 ? "No tracked events" : `${participation.attended} of ${participation.sample} commitments kept`}
          </span>
        </section>
      </div>

      <div className="member-detail-grid">
        <section className="card member-detail-card">
          <h2>Participation</h2>
          {participation.events.length === 0 ? (
            <p className="muted">No event participation has been tracked yet.</p>
          ) : (
            <ul className="detail-list">
              {participation.events.map((event) => (
                <li key={event.eventId}>
                  <span><strong>{event.title}</strong><span className="muted small">{shortDate(event.startsAt)}</span></span>
                  <span className={`badge ${event.outcome === "no_show" || event.outcome === "unregistered" ? "badge-none" : ""}`}>
                    {OUTCOME_LABELS[event.outcome] ?? event.outcome}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card member-detail-card">
          <h2>Report history</h2>
          {!reports || reports.items.length === 0 ? (
            <p className="muted">No strength reports yet.</p>
          ) : (
            <ul className="detail-list">
              {reports.items.slice(0, 12).map((report) => (
                <li key={report.reportId} className="report-history-item">
                  <span>
                    <strong>{shortDate(report.effectiveAt)}</strong>
                    <span className="muted small">{report.source}</span>
                  </span>
                  <span className="report-values">
                    {report.values.map((value) => (
                      <span key={value.metric}>{METRIC_LABELS[value.metric] ?? value.metric}: {full(value.value)}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
