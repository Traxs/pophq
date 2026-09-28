import { useEffect, useState, type FormEvent } from "react";
import type { AccessAuditRecord, AccountIdentity, OnboardingInvitationAudit, Reports, RosterRow } from "../api";
import { AccountIdentityPanel } from "../components/AccountIdentity";
import { ErrorBanner } from "../components/Chrome";
import { InviteMemberForm } from "../components/InviteMember";
import { ResetPasswordForm } from "../components/ResetPassword";
import { ReportModeration } from "../components/ReportModeration";
import { Sheet } from "../components/Sheet";
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

function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function MemberPage({ playerId }: { playerId: string }) {
  const { api, account, isOfficer, dataVersion, dataChanged } = useSession();
  const canManageIdentity = account?.rank === "R4" || account?.rank === "R5";
  const [row, setRow] = useState<RosterRow | null | undefined>(undefined);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [reports, setReports] = useState<Reports | null>(null);
  const [accessAudit, setAccessAudit] = useState<AccessAuditRecord[]>([]);
  const [invitationAudit, setInvitationAudit] = useState<OnboardingInvitationAudit[]>([]);
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inviting, setInviting] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [changingMembership, setChangingMembership] = useState(false);

  useEffect(() => {
    if (!isOfficer) return;
    Promise.all([api.roster(), api.reports(playerId), api.accessAudit(playerId), canManageIdentity ? api.accountIdentity(playerId) : Promise.resolve(null)])
      .then(([roster, reportHistory, audit, accountIdentity]) => {
        setRoster(roster.items);
        setRow(roster.items.find((item) => item.playerId === playerId) ?? null);
        setReports(reportHistory);
        setAccessAudit(audit.items);
        setInvitationAudit(audit.invitations);
        setIdentity(accountIdentity);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, isOfficer, canManageIdentity, playerId, dataVersion, attempt]);

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
        <div className="member-profile-actions">
          {!row.hasLogin && row.status !== "transferred_out" && (
            <button type="button" className="btn btn-primary btn-small" onClick={() => setInviting(true)}>Invite</button>
          )}
          {canManageIdentity && <button
            type="button"
            className={`btn btn-small ${row.status === "transferred_out" ? "btn-primary" : "btn-danger"}`}
            onClick={() => setChangingMembership(true)}
          >{row.status === "transferred_out" ? "Welcome back" : "Mark as left"}</button>}
        </div>
      </header>

      <Sheet open={inviting} title={`Invite ${row.name}`} onClose={() => setInviting(false)}>
        <InviteMemberForm
          candidates={roster}
          initialAccount={row}
          onChanged={dataChanged}
          onClose={() => setInviting(false)}
        />
      </Sheet>

      <Sheet open={resettingPassword} title={`Reset ${row.name}'s password`} onClose={() => setResettingPassword(false)}>
        <ResetPasswordForm
          playerId={row.playerId}
          memberName={row.name}
          onCompleted={(audit) => setAccessAudit((items) => [audit, ...items.filter((item) => item.auditId !== audit.auditId)])}
          onClose={() => setResettingPassword(false)}
        />
      </Sheet>

      <Sheet
        open={changingMembership}
        title={row.status === "transferred_out" ? `Welcome ${row.name} back` : `Mark ${row.name} as having left`}
        onClose={() => setChangingMembership(false)}
      >
        <MembershipForm
          playerId={row.playerId}
          memberName={row.name}
          active={row.status === "transferred_out"}
          accounts={identity?.accounts ?? [row]}
          onCompleted={(updated) => { setIdentity(updated); setChangingMembership(false); dataChanged(); }}
          onClose={() => setChangingMembership(false)}
        />
      </Sheet>

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
            {participation.sample === 0 ? "No tracked attendance" : `${participation.attended} of ${participation.sample} counted events attended`}
          </span>
        </section>
      </div>

      <div className="member-detail-grid">
        {canManageIdentity && identity && <AccountIdentityPanel
          anchorPlayerId={playerId}
          identity={identity}
          roster={roster}
          onChanged={setIdentity}
        />}
        {(row.hasLogin || accessAudit.length > 0 || invitationAudit.length > 0) && <section className="card member-detail-card access-security-card">
          <div className="section-head">
            <div>
              <h2>Access security</h2>
              <p className="muted small">Invitations and password recovery are retained for fraud review.</p>
            </div>
            {row.loginMethod === "password" && <button type="button" className="btn btn-danger btn-small" onClick={() => setResettingPassword(true)}>
              Reset password
            </button>}
          </div>
          {row.loginMethod === "email" && <p className="muted">This member signs in with emailed codes; there is no password to reset.</p>}
          {row.loginMethod === null && <p className="muted">The sign-in method predates access tracking. Reset is disabled until it is verified.</p>}
          {accessAudit.length === 0 ? <p className="muted">No password resets recorded.</p> : <ul className="detail-list access-audit-list">
            {accessAudit.map((audit) => <li key={audit.auditId}>
              <span>
                <strong>Password reset {audit.status}</strong>
                <span className="muted small">{new Date(audit.requestedAt).toLocaleString()} · {audit.requestedByName ?? audit.requestedBy}</span>
                <span className="small">{audit.justification}</span>
              </span>
              <span className={`badge ${audit.status === "failed" ? "badge-none" : ""}`}>{audit.status}</span>
            </li>)}
          </ul>}
          {invitationAudit.length > 0 && <>
            <h3>Invitation history</h3>
            <ul className="detail-list access-audit-list">{invitationAudit.map((invite) => <li key={invite.inviteId}>
              <span>
                <strong>Onboarding invitation {invite.status}</strong>
                <span className="muted small">Created {new Date(invite.createdAt).toLocaleString()} · expires {new Date(invite.expiresAt).toLocaleString()}</span>
                {invite.method && <span className="small">Selected {invite.method === "email" ? "email code" : "login and password"}</span>}
              </span>
              <span className={`badge ${invite.status === "failed" ? "badge-none" : ""}`}>{invite.status}</span>
            </li>)}</ul>
          </>}
        </section>}

        <section className="card member-detail-card">
          <h2>Participation</h2>
          {participation.events.length === 0 ? (
            <p className="muted">No event participation has been tracked yet.</p>
          ) : (
            <ul className="detail-list">
              {participation.events.map((event) => (
                <li key={event.eventId}>
                  <span>
                    <strong>{event.title}</strong>
                    <span className="muted small">{shortDate(event.startsAt)}</span>
                    {event.evidenceAccountName && <span className="small participation-evidence">
                      Via {event.evidenceAccountName}{event.evidenceSessionLabel ? ` · ${event.evidenceSessionLabel}` : ""}
                    </span>}
                  </span>
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
              {reports.items.toSorted((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.reportId.localeCompare(a.reportId)).slice(0, 12).map((report) => (
                <li key={report.reportId} className={`report-history-item ${report.ignoredAt ? "report-row-ignored" : ""}`}>
                  <span>
                    <strong>{shortDate(report.effectiveAt)}</strong>
                    <span className="muted small">{report.source}{report.ignoredAt ? " · Ignored" : ""}</span>
                    {report.ignoredAt && <span className="small report-status">
                      Ignored {shortDate(report.ignoredAt)} by {report.ignoredByName ?? "a moderator"}
                      {report.ignoreReason ? ` · ${report.ignoreReason}` : ""}
                    </span>}
                  </span>
                  <span className="report-values">
                    {report.values.map((value) => (
                      <span key={value.metric}>{METRIC_LABELS[value.metric] ?? value.metric}: {full(value.value)}</span>
                    ))}
                    <ReportModeration playerId={playerId} report={report} onChanged={dataChanged} />
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

function MembershipForm({
  playerId,
  memberName,
  active,
  accounts,
  onCompleted,
  onClose,
}: {
  playerId: string;
  memberName: string;
  active: boolean;
  accounts: { playerId: string; name: string }[];
  onCompleted: (identity: AccountIdentity) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCompleted(await api.setPersonMembership(playerId, active, effectiveDate, reason));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change alliance membership.");
    } finally {
      setSaving(false);
    }
  };
  return <form className="form identity-form" onSubmit={submit}>
    {error && <ErrorBanner message={error} />}
    <p className="muted identity-form-intro">
      {active
        ? `Restore ${memberName}'s POP membership and sign-in access.`
        : `Keep all history, but remove this person from the active roster, events, attendance and reward calculations.`}
    </p>
    <section className="identity-membership-impact" aria-label="Affected game accounts">
      <strong>{accounts.length} game {accounts.length === 1 ? "account" : "accounts"} affected</strong>
      <ul>{accounts.map((account) => <li key={account.playerId}>{account.name} <span className="muted">· {account.playerId}</span></li>)}</ul>
      {!active && <p className="muted small">Their shared POP HQ login will be disabled. It can be restored later with Welcome back.</p>}
    </section>
    <div className="field">
      <label htmlFor="membership-effective-date">{active ? "Date they returned to POP" : "Date they left POP"}</label>
      <input id="membership-effective-date" type="date" value={effectiveDate} max={today()} onChange={(event) => setEffectiveDate(event.target.value)} required />
      <span className="field-help">Attendance is counted only while this person belongs to POP. The audit separately records when you saved this change.</span>
    </div>
    <div className="field identity-reason">
      <label htmlFor="membership-reason">Reason for this change</label>
      <textarea id="membership-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={200} rows={3} required placeholder={active ? "How was their return confirmed?" : "Why are they leaving the alliance?"} />
      <span className="field-help">Saved permanently in the officer audit history.</span>
    </div>
    <div className="form-actions identity-form-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className={`btn ${active ? "btn-primary" : "btn-danger"}`} disabled={saving || reason.trim().length < 5}>{saving ? "Saving…" : active ? "Restore membership" : "Mark as left"}</button>
    </div>
  </form>;
}
