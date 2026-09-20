import { useEffect, useState } from "react";
import { ApiError, type Answer, type EventDetail, type EventMember, type SessionView } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { useToast } from "../components/Toast";
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
      {event.notes && <p className="event-notes">{event.notes}</p>}

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {event.sessions.length > 0 ? (
        <ul className="stack">
          {event.sessions.map((session) => (
            <li key={session.id}>
              <SessionCard
                session={session}
                closed={event.closed}
                busy={busy}
                canAnswer={account !== undefined}
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
          disabled={event.closed || busy !== null}
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
  onJoin,
}: {
  session: SessionView;
  closed: boolean;
  busy: string | null;
  canAnswer: boolean;
  onJoin: () => void;
}) {
  const capacity = session.starters === undefined ? null : session.starters + (session.subs ?? 0);
  const filled = capacity ? Math.min(100, Math.round((session.signedUp / capacity) * 100)) : 0;
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
            {Math.min(session.signedUp, session.starters!)} of {session.starters} starters
            {session.subs
              ? ` · ${Math.min(Math.max(0, session.signedUp - session.starters!), session.subs)} of ${session.subs} subs`
              : ""}
            {session.signedUp > capacity
              ? ` · full, ${session.signedUp - capacity} waiting`
              : session.signedUp === capacity
                ? " · full"
                : ` · ${capacity - session.signedUp} spots free`}
          </p>
          <div className="meter" role="img" aria-label={`${session.signedUp} of ${capacity} places taken`}>
            <span style={{ width: `${filled}%` }} />
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

      {session.signedUpNames.length > 0 && (
        <details className="signups">
          <summary className="text-btn">Who signed up ({session.signedUpNames.length})</summary>
          <ul className="member-chips">
            {session.signedUpNames.map((name) => (
              <li key={name} className="chip-static">
                {name}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/** Officer view: every member with the numbers needed to balance the legions (EVT-04). */
function OfficerTable({ event, members }: { event: EventDetail; members: EventMember[] }) {
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
              <th scope="col" className="num">
                Power
              </th>
              <th scope="col">Furnace</th>
              <th scope="col">Last report</th>
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
                <td className="num">{m.power === null ? "–" : compact(m.power)}</td>
                <td>{m.furnace ?? "–"}</td>
                <td>{m.lastReportAt ? relativeDay(m.lastReportAt) : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
