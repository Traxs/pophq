import { useEffect, useState } from "react";
import {
  ApiError,
  type Answer,
  type AttendanceStatus,
  type EventDetail,
  type EventMember,
  type LineupEntryView,
  type PublishedLineup,
  type PublishedStrategy,
  type SessionView,
  STRATEGY_ROLES,
  type StrategyRole,
} from "../api";
import { ErrorBanner } from "../components/Chrome";
import { useToast } from "../components/Toast";
import { MiniChart } from "../components/MiniChart";
import { compact, dayTime, full, relativeDay, shortTime, untilText } from "../format";
import { countDraft, draftFor, entriesToPublish, type LineupDraftRow } from "../lineup";
import { navigate } from "../router";
import { useSession } from "../session";
import { assignmentsToPublish, StrategyText, strategyDraftFor, type StrategyDraftAssignment } from "../strategy";

/** One event in full: the parts you can join, who signed up, and the officer table. */
export function EventPage({ eventId }: { eventId: string }) {
  const { api, account, isOfficer, dataVersion, dataChanged } = useSession();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    api
      .event(eventId)
      .then((e) => {
        setEvent(e);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, eventId, dataVersion]);

  const choose = async (answer: Answer, sessionId?: string) => {
    if (!account) return;
    setBusy(sessionId ?? answer);
    setError(null);
    try {
      await api.answer(eventId, account.playerId, answer, sessionId);
      const label = sessionId ? event?.sessions.find((s) => s.id === sessionId)?.label : undefined;
      toast(label ? `You're in for ${label}` : "Signup withdrawn");
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save your answer.");
    } finally {
      setBusy(null);
    }
  };

  const publish = async (sessionId: string, rows: LineupDraftRow[], version: number) => {
    setError(null);
    try {
      const published = await api.publishLineup(eventId, sessionId, entriesToPublish(rows), version);
      toast(`Lineup published (v${published.version})`);
      dataChanged();
    } catch (e) {
      // A stale version means someone else published first; the message says to reload.
      setError(e instanceof ApiError ? e.message : "Couldn't publish the lineup.");
      throw e;
    }
  };

  const publishStrategy = async (
    sessionId: string,
    body: string,
    assignments: StrategyDraftAssignment[],
    version: number,
  ) => {
    setError(null);
    try {
      const published = await api.publishStrategy(
        eventId,
        sessionId,
        body,
        assignmentsToPublish(assignments),
        version,
      );
      toast(`Strategy published (v${published.version})`);
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't publish the strategy.");
      throw e;
    }
  };

  if (error && !event) return <ErrorBanner message={error} onRetry={() => navigate("/events")} />;
  if (!event) return <div className="card skeleton" style={{ height: 200 }} />;

  return (
    <>
      <button type="button" className="text-btn" onClick={() => navigate("/events")}>
        ‹ All events
      </button>

      <div className="page-head">
        <h1 className="page-title">{event.title}</h1>
      </div>
      <p className="muted">
        {dayTime(event.startsAt)} ·{" "}
        {event.closed ? "answers closed" : `answers close ${untilText(event.deadlineAt)} (${dayTime(event.deadlineAt)})`}
      </p>
      {event.closed && isOfficer && (
        <p className="banner banner-warn">
          Answers are closed for members. You can still change who is coming until the event starts.
        </p>
      )}
      {event.notes && <p className="event-notes">{event.notes}</p>}

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {event.sessions.length > 0 ? (
        <ul className="stack">
          {event.sessions.map((session) => (
            <li key={session.id}>
              <SessionCard
                session={session}
                closed={event.closed && !isOfficer}
                busy={busy}
                canAnswer={account !== undefined}
                isOfficer={isOfficer}
                myPlayerId={account?.playerId}
                strategyTemplate={event.strategyTemplate ?? ""}
                onJoin={() => void choose("yes", session.id)}
                {...(isOfficer ? { onPublish: publish, onPublishStrategy: publishStrategy } : {})}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">This event has no parts to choose between.</p>
      )}

      {account && event.myAnswer === "yes" ? (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={(event.closed && !isOfficer) || busy !== null}
          onClick={() => void choose("no")}
        >
          {busy === "no" ? "…" : "Withdraw signup"}
        </button>
      ) : account ? (
        <p className="pill pill-flat">Not signed up — join either legion above</p>
      ) : null}

      {isOfficer && event.members && <OfficerTable event={event} members={event.members} />}
    </>
  );
}

function SessionCard({
  session,
  closed,
  busy,
  canAnswer,
  isOfficer,
  myPlayerId,
  onJoin,
  onPublish,
  strategyTemplate,
  onPublishStrategy,
}: {
  session: SessionView;
  closed: boolean;
  busy: string | null;
  canAnswer: boolean;
  isOfficer: boolean;
  myPlayerId: string | undefined;
  onJoin: () => void;
  strategyTemplate: string;
  /** Officers only: publish or change the lineup for this part. */
  onPublish?: (sessionId: string, rows: LineupDraftRow[], version: number) => Promise<void>;
  /** Officers only: publish or change the plan and assignments for this part. */
  onPublishStrategy?: (
    sessionId: string,
    body: string,
    assignments: StrategyDraftAssignment[],
    version: number,
  ) => Promise<void>;
}) {
  const starters = session.starters;
  const subs = session.subs ?? 0;
  const capacity = starters === undefined ? null : starters + subs;
  // Before a lineup exists the meter shows who signed up; afterwards it shows the decision,
  // because "10 signed up" stops being the interesting number once officers have picked.
  const taken = session.lineup
    ? {
        starters: session.lineup.entries.filter((e) => e.role === "starter").length,
        subs: session.lineup.entries.filter((e) => e.role === "sub").length,
      }
    : null;
  const startersFilled =
    starters === undefined ? 0 : taken ? Math.min(taken.starters, starters) : Math.min(session.signedUp, starters);
  const subsFilled =
    starters === undefined
      ? 0
      : taken
        ? Math.min(taken.subs, subs)
        : Math.min(Math.max(0, session.signedUp - starters), subs);
  const startersFree = starters === undefined ? 0 : starters - startersFilled;
  const subsFree = subs - subsFilled;
  // Nobody "waits" once a lineup exists: they are either in it or they are not.
  const waiting = capacity === null || taken ? 0 : Math.max(0, session.signedUp - capacity);
  const joined = session.yourStanding !== undefined;

  return (
    <article className={`card session${joined ? " session-joined" : ""}`}>
      <div className="event-head">
        <h2 className="event-title">
          {session.label} · {shortTime(session.startsAt)}
        </h2>
        {canAnswer && (
          <button type="button" className={joined ? "btn btn-quiet btn-small" : "btn btn-primary btn-small"} disabled={closed || busy !== null} onClick={onJoin}>
            {busy === session.id ? "…" : joined ? "You're in" : "Join"}
          </button>
        )}
      </div>

      {capacity !== null ? (
        <>
          <p className="muted small">
            {startersFilled} of {starters} starting
            {subs > 0 && ` · ${subsFilled} of ${subs} subs`}
            {startersFree > 0
              ? ` · ${startersFree} starting ${startersFree === 1 ? "place" : "places"} free`
              : subsFree > 0
                ? ` · starting full, ${subsFree} sub ${subsFree === 1 ? "place" : "places"} left`
                : waiting > 0
                  ? ` · full, ${waiting} waiting`
                  : " · full"}
          </p>
          <div
            className="meter meter-split"
            role="img"
            aria-label={`${startersFilled} of ${starters} starting places and ${subsFilled} of ${subs} substitute places taken`}
          >
            <span className="meter-starters" style={{ width: `${(startersFilled / capacity) * 100}%` }} />
            <span className="meter-subs" style={{ width: `${(subsFilled / capacity) * 100}%` }} />
            {/* The line between starting places and substitutes, so the eye finds it at once. */}
            {starters !== undefined && subs > 0 && (
              <i className="meter-divider" style={{ left: `${(starters / capacity) * 100}%` }} aria-hidden="true" />
            )}
          </div>
        </>
      ) : (
        <p className="muted small">{session.signedUp} signed up</p>
      )}

      {/* Once a lineup is published it answers "am I playing?", so the estimate steps aside. */}
      {session.lineup ? (
        session.yourPlace ? (
          <p className={session.yourPlace.role === "starter" ? "pill pill-up" : "pill pill-warn"}>
            {session.yourPlace.role === "starter"
              ? `You're starting · #${session.yourPlace.position}`
              : `You're substitute #${session.yourPlace.position}`}{" "}
            — officers published this lineup
          </p>
        ) : (
          joined && <p className="pill pill-flat">Not in this lineup — officers published it {relativeDay(session.lineup.publishedAt)}</p>
        )
      ) : (
        session.yourStanding && (
          <p className={session.yourStanding.likely === "starter" ? "pill pill-up" : "pill pill-warn"}>
            {session.yourStanding.likely === "starter" ? "Likely starting" : "Likely a substitute"} · {session.yourStanding.position}
            {" of "}
            {session.yourStanding.signedUp} by Foundry strength — estimate, officers pick the lineup
          </p>
        )
      )}

      {session.lineup && <LineupList lineup={session.lineup} myPlayerId={myPlayerId} />}

      {session.strategy && <StrategyView strategy={session.strategy} myPlayerId={myPlayerId} />}

      {session.yourAssignment && (
        <p className="pill pill-flat">
          Your assignment: {session.yourAssignment.role}
          {session.yourAssignment.duty ? ` · ${session.yourAssignment.duty}` : ""}
        </p>
      )}

      {session.signedUpList.length > 0 && (
        <details className="signups">
          <summary className="text-btn">Who signed up ({session.signedUpList.length})</summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Member</th>
                  <th scope="col" className="num">
                    Foundry
                  </th>
                  {isOfficer && <th scope="col">Attendance</th>}
                  <th scope="col">Likely</th>
                </tr>
              </thead>
              <tbody>
                {session.signedUpList.map((entry) => (
                  <tr key={entry.playerId} className={entry.playerId === myPlayerId ? "row-me" : undefined}>
                    <td className="num">{entry.position}</td>
                    <td>{entry.name}</td>
                    <td className="num">{entry.foundryStrength === null ? "–" : full(entry.foundryStrength)}</td>
                    {isOfficer && (
                      <td>
                        {entry.attendanceRate === null || entry.attendanceRate === undefined
                          ? "–"
                          : `${Math.round(entry.attendanceRate * 100)}%`}
                      </td>
                    )}
                    <td>
                      <span className={entry.likely === "starter" ? "pill pill-up" : "pill pill-warn"}>
                        {entry.likely === "starter" ? "Starter" : "Sub"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            {session.lineup
              ? "This is the ranking the lineup above was built from."
              : isOfficer
                ? "Ranked by Foundry strength (70%) and attendance (30%) — an estimate until officers publish the lineup."
                : "Ranked by Foundry strength and reliability — an estimate until officers publish the lineup."}
          </p>
        </details>
      )}

      {isOfficer && onPublish && (
        <LineupEditor session={session} onPublish={onPublish} />
      )}
      {isOfficer && onPublishStrategy && (
        <StrategyEditor session={session} template={strategyTemplate} onPublish={onPublishStrategy} />
      )}
    </article>
  );
}

/** The published plan and roles as every member sees them. */
function StrategyView({ strategy, myPlayerId }: { strategy: PublishedStrategy; myPlayerId: string | undefined }) {
  return (
    <section className="strategy" aria-label="Published strategy">
      <h3 className="section-label">
        Strategy <span className="muted small">· published {relativeDay(strategy.publishedAt)}</span>
      </h3>
      {strategy.body && (
        <div className="strategy-body">
          <StrategyText text={strategy.body} />
        </div>
      )}
      {strategy.assignments.length > 0 && (
        <div className="table-wrap">
          <table className="table strategy-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Duty</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {strategy.assignments.map((assignment) => (
                <tr key={assignment.playerId} className={assignment.playerId === myPlayerId ? "row-me" : undefined}>
                  <th scope="row">{assignment.name}</th>
                  <td>{assignment.role}</td>
                  <td>{assignment.duty ?? "–"}</td>
                  <td>{assignment.note ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StrategyEditor({
  session,
  template,
  onPublish,
}: {
  session: SessionView;
  template: string;
  onPublish: (sessionId: string, body: string, assignments: StrategyDraftAssignment[], version: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [rows, setRows] = useState<StrategyDraftAssignment[]>([]);
  const [saving, setSaving] = useState(false);

  const start = () => {
    setBody(session.strategy?.body ?? template);
    setRows(strategyDraftFor(session));
    setOpen(true);
  };
  const change = (playerId: string, patch: Partial<Pick<StrategyDraftAssignment, "role" | "duty" | "note">>) =>
    setRows((current) => current.map((row) => (row.playerId === playerId ? { ...row, ...patch } : row)));

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-small" onClick={start}>
        {session.strategy ? `Edit strategy (v${session.strategy.version})` : "Publish strategy"}
      </button>
    );
  }

  return (
    <div className="strategy-editor stack">
      <label className="field">
        <span>Plan</span>
        <textarea
          rows={10}
          maxLength={20_000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Use blank lines, - bullets and **bold** text."
        />
      </label>
      {rows.length === 0 ? (
        <p className="muted small">Publish a lineup first to add member assignments. You can still publish the plan.</p>
      ) : (
        <div className="strategy-assignment-editor">
          {rows.map((row) => (
            <fieldset key={row.playerId} className="strategy-assignment">
              <legend>{row.name}</legend>
              <label>
                <span>Role</span>
                <select
                  aria-label={`${row.name}'s strategy role in ${session.label}`}
                  value={row.role}
                  onChange={(event) => change(row.playerId, { role: event.target.value as StrategyRole | "" })}
                >
                  <option value="">Unassigned</option>
                  {STRATEGY_ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Duty</span>
                <input value={row.duty} maxLength={200} onChange={(event) => change(row.playerId, { duty: event.target.value })} />
              </label>
              <label>
                <span>Note</span>
                <input value={row.note} maxLength={500} onChange={(event) => change(row.playerId, { note: event.target.value })} />
              </label>
            </fieldset>
          ))}
        </div>
      )}
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onPublish(session.id, body, rows, session.strategy?.version ?? 0)
              .then(() => setOpen(false))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Publishing…" : session.strategy ? "Publish changes" : "Publish strategy"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The published lineup as everyone sees it: starters, then substitutes, own row highlighted. */
function LineupList({ lineup, myPlayerId }: { lineup: PublishedLineup; myPlayerId: string | undefined }) {
  const starters = lineup.entries.filter((e) => e.role === "starter");
  const subs = lineup.entries.filter((e) => e.role === "sub");
  const row = (entry: LineupEntryView) => (
    <li key={entry.playerId} className={entry.playerId === myPlayerId ? "lineup-row row-me" : "lineup-row"}>
      <span className="num muted">{entry.position}</span>
      <span>
        {entry.name}
        {!entry.signedUp && <span className="muted small"> · didn't answer</span>}
      </span>
      <span className="num muted">{entry.foundryStrength === null ? "–" : full(entry.foundryStrength)}</span>
    </li>
  );

  return (
    <section className="lineup" aria-label="Published lineup">
      <h3 className="section-label">
        Lineup <span className="muted small">· published {relativeDay(lineup.publishedAt)}</span>
      </h3>
      {lineup.note && <p className="event-notes">{lineup.note}</p>}
      <p className="muted small">Starting ({starters.length})</p>
      <ul className="lineup-list">{starters.map(row)}</ul>
      {subs.length > 0 && (
        <>
          <p className="muted small">Substitutes ({subs.length})</p>
          <ul className="lineup-list">{subs.map(row)}</ul>
        </>
      )}
    </section>
  );
}

/**
 * Officers turn the estimate into a decision (P5.4). The list opens on the published lineup, or
 * on the estimate when nothing is published yet, so the usual job is to check and publish.
 */
function LineupEditor({
  session,
  onPublish,
}: {
  session: SessionView;
  onPublish: (sessionId: string, rows: LineupDraftRow[], version: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LineupDraftRow[]>([]);
  const [saving, setSaving] = useState(false);

  const start = () => {
    setRows(draftFor(session));
    setOpen(true);
  };
  const counts = countDraft(rows, session);
  const setRole = (playerId: string, role: LineupDraftRow["role"]) =>
    setRows((current) => current.map((r) => (r.playerId === playerId ? { ...r, role } : r)));

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-small" onClick={start}>
        {session.lineup ? `Edit lineup (v${session.lineup.version})` : "Publish lineup"}
      </button>
    );
  }

  return (
    <div className="lineup-editor stack">
      <p className="muted small">
        Starting {counts.starters}
        {session.starters !== undefined && ` of ${session.starters}`} · Substitutes {counts.subs}
        {session.subs !== undefined && ` of ${session.subs}`}
        {counts.overCapacity && <span className="pill pill-warn"> too many</span>}
      </p>
      <ul className="lineup-list">
        {rows.map((r) => (
          <li key={r.playerId} className="lineup-row">
            <span>
              {r.name}
              {!r.signedUp && <span className="muted small"> · didn't answer</span>}
            </span>
            <span className="num muted">{r.foundryStrength === null ? "–" : full(r.foundryStrength)}</span>
            <select
              aria-label={`${r.name}'s place in ${session.label}`}
              value={r.role}
              onChange={(e) => setRole(r.playerId, e.target.value as LineupDraftRow["role"])}
            >
              <option value="starter">Starting</option>
              <option value="sub">Substitute</option>
              <option value="out">Not playing</option>
            </select>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={saving || counts.overCapacity}
          onClick={() => {
            setSaving(true);
            void onPublish(session.id, rows, session.lineup?.version ?? 0)
              .then(() => setOpen(false))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Publishing…" : session.lineup ? "Publish changes" : "Publish lineup"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Officer view: every member with the numbers needed to balance the legions (EVT-04). */
function OfficerTable({ event, members }: { event: EventDetail; members: EventMember[] }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const started = Date.parse(event.startsAt) <= Date.now();
  const [saving, setSaving] = useState<string | null>(null);

  const mark = async (member: EventMember, status: AttendanceStatus) => {
    setSaving(member.playerId);
    try {
      await api.attendance(event.eventId, member.playerId, status, member.sessionId ?? undefined);
      toast(`${member.name}: ${status}`);
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save attendance");
    } finally {
      setSaving(null);
    }
  };
  const answerLabel = (m: EventMember) =>
    m.answer === "yes"
      ? (event.sessions.find((s) => s.id === m.sessionId)?.label ?? "Yes")
        : m.answer === "no"
          ? "Not signed up"
        : m.answer === "maybe"
          ? "Maybe"
          : "—";

  const totals = event.sessions.map((session) => {
    const inSession = members.filter((m) => m.sessionId === session.id && m.answer === "yes");
    return {
      label: session.label,
      count: inSession.length,
      strength: inSession.reduce((sum, m) => sum + (m.foundryStrength ?? 0), 0),
      power: inSession.reduce((sum, m) => sum + (m.power ?? 0), 0),
    };
  });

  const ordered = [...members].toSorted(
    (a, b) => (b.foundryStrength ?? -1) - (a.foundryStrength ?? -1) || a.name.localeCompare(b.name),
  );

  return (
    <section className="card stack" aria-labelledby="who-title">
      <h2 id="who-title" className="section-label">
        Who's coming
      </h2>

      <ul className="movers">
        {totals.map((t) => (
          <li key={t.label} className="mover">
            <span>
              {t.label}: <strong>{t.count}</strong>
            </span>
            <span className="muted small">
              {compact(t.strength)} strength · {compact(t.power)} power
            </span>
          </li>
        ))}
      </ul>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Answer</th>
              <th scope="col">Lineup</th>
              <th scope="col" className="num">
                Foundry
              </th>
              <th scope="col" title="Foundry strength at the end of each of the last six months">
                Strength 6m
              </th>
              <th scope="col" title="Attendance, averaged over each month and the two before it">
                Attendance 6m
              </th>
              <th scope="col" className="num">
                Power
              </th>
              <th scope="col">Furnace</th>
              <th scope="col">{started ? "Turned up" : "Last report"}</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((m) => (
              <tr key={m.playerId}>
                <td>
                  {m.name}
                  {m.rank && <span className="muted"> · {m.rank}</span>}
                </td>
                <td>{answerLabel(m)}</td>
                <td>
                  {m.lineup ? (
                    <span className={m.lineup.role === "starter" ? "pill pill-up" : "pill pill-warn"}>
                      {event.sessions.find((s) => s.id === m.lineup!.sessionId)?.label ?? m.lineup.sessionId}
                      {m.lineup.role === "starter" ? " · start " : " · sub "}
                      {m.lineup.position}
                    </span>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="num">{m.foundryStrength === null ? "–" : full(m.foundryStrength)}</td>
                <td>
                  <MiniChart values={m.strengthTrend} label={`${m.name}: Foundry strength over six months`} />
                </td>
                <td>
                  <MiniChart
                    values={m.attendanceTrend}
                    domain={[0, 1]}
                    midline
                    label={`${m.name}: attendance, three-month trailing average over the last six months`}
                  />
                </td>
                <td className="num">{m.power === null ? "–" : compact(m.power)}</td>
                <td>{m.furnace ?? "–"}</td>
                <td>
                  {started ? (
                    <select
                      aria-label={`Did ${m.name} turn up?`}
                      value={m.attended ?? ""}
                      disabled={saving === m.playerId}
                      onChange={(e) => void mark(m, e.target.value as AttendanceStatus)}
                    >
                      <option value="">–</option>
                      <option value="present">Present</option>
                      <option value="absent">Absent</option>
                      <option value="excused">Excused</option>
                    </select>
                  ) : m.lastReportAt ? (
                    relativeDay(m.lastReportAt)
                  ) : (
                    "never"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
