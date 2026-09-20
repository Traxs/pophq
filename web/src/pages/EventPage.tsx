import { useEffect, useState } from "react";
import { ApiError, type Answer, type AttendanceStatus, type EventDetail, type EventMember, type SessionView } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { useToast } from "../components/Toast";
import { MiniChart } from "../components/MiniChart";
import { compact, dayTime, full, relativeDay, shortTime, untilText } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

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
      toast(label ? `You're in for ${label}` : "Marked as not coming");
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save your answer.");
    } finally {
      setBusy(null);
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
                onJoin={() => void choose("yes", session.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">This event has no parts to choose between.</p>
      )}

      {account && (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={(event.closed && !isOfficer) || busy !== null}
          onClick={() => void choose("no")}
        >
          {event.myAnswer === "no" ? "Marked as not coming" : "I can't make it"}
        </button>
      )}

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
}: {
  session: SessionView;
  closed: boolean;
  busy: string | null;
  canAnswer: boolean;
  isOfficer: boolean;
  myPlayerId: string | undefined;
  onJoin: () => void;
}) {
  const starters = session.starters;
  const subs = session.subs ?? 0;
  const capacity = starters === undefined ? null : starters + subs;
  // A substitute place is not a free place: count the two separately.
  const startersFilled = starters === undefined ? 0 : Math.min(session.signedUp, starters);
  const subsFilled = starters === undefined ? 0 : Math.min(Math.max(0, session.signedUp - starters), subs);
  const startersFree = starters === undefined ? 0 : starters - startersFilled;
  const subsFree = subs - subsFilled;
  const waiting = capacity === null ? 0 : Math.max(0, session.signedUp - capacity);
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

      {session.yourStanding && (
        <p className={session.yourStanding.likely === "starter" ? "pill pill-up" : "pill pill-warn"}>
          {session.yourStanding.likely === "starter" ? "Likely starting" : "Likely a substitute"} · {session.yourStanding.position}
          {" of "}
          {session.yourStanding.signedUp} by Foundry strength — estimate, officers pick the lineup
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
            {isOfficer
              ? "Ranked by Foundry strength (70%) and attendance (30%) — an estimate until officers publish the lineup."
              : "Ranked by Foundry strength and reliability — an estimate until officers publish the lineup."}
          </p>
        </details>
      )}
    </article>
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
        ? "Can't"
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
              <th scope="col" className="num">
                Foundry
              </th>
              <th scope="col">6 months</th>
              <th scope="col">Attendance</th>
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
                <td className="num">{m.foundryStrength === null ? "–" : full(m.foundryStrength)}</td>
                <td>
                  <MiniChart values={m.strengthTrend} label={`${m.name}: Foundry strength over six months`} />
                </td>
                <td>
                  <MiniChart
                    values={m.attendanceTrend}
                    domain={[0, 1]}
                    midline
                    label={`${m.name}: attendance over six months`}
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
