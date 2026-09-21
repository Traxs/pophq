import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type Answer, type EventDetail, type EventListItem, type EventKind, type EventMember } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { dayTime, shortTime, untilText } from "../format";
import { leadDaysOf, previewDeadline, toLocalInput } from "../eventTiming";
import { navigate } from "../router";
import { useSession } from "../session";
import { NoAccount } from "./Home";

const KINDS: { value: EventKind; label: string }[] = [
  { value: "foundry", label: "Foundry" },
  { value: "bear", label: "Bear hunt" },
  { value: "svs", label: "SvS" },
  { value: "other", label: "Other" },
];

const ANSWERS: { value: Answer; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
];

const kindLabel = (kind: EventKind) => KINDS.find((k) => k.value === kind)?.label ?? "Event";

/** How long before the start answers close. Foundry needs days: officers sign people up in game. */
const LEAD_CHOICES = [
  { days: 3, label: "3 days before" },
  { days: 2, label: "2 days before" },
  { days: 1, label: "1 day before" },
  { days: 0, label: "1 hour before" },
];
const DEFAULT_LEAD: Record<EventKind, number> = { foundry: 3, svs: 3, bear: 0, other: 0 };
const ALL_EVENT_HISTORY = "1970-01-01T00:00:00.000Z";

/** A Foundry is one event with two legions; other types have no parts to choose from. */
const defaultSessions = (kind: EventKind): { id?: string; label: string; startsAt: string }[] =>
  kind === "foundry"
    ? [
        { id: "L1", label: "Legion 1", startsAt: "" },
        { id: "L2", label: "Legion 2", startsAt: "" },
      ]
    : [];

export function Events() {
  const { api, me, account, isOfficer, dataVersion, dataChanged } = useSession();
  const [items, setItems] = useState<EventListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventListItem | null>(null);
  const [configuring, setConfiguring] = useState<EventListItem | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    api
      .events(showHistory ? ALL_EVENT_HISTORY : undefined)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, dataVersion, attempt, showHistory]);

  if (me && me.accounts.length === 0) return <NoAccount />;

  const now = new Date();
  const upcoming = (items ?? []).filter((e) => Date.parse(e.startsAt) >= now.getTime());
  const past = (items ?? []).filter((e) => Date.parse(e.startsAt) < now.getTime());

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Events</h1>
        {isOfficer && (
          <button type="button" className="btn btn-primary btn-small" onClick={() => setCreating(true)}>
            New event
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}

      {items === null && !error && <div className="card skeleton" style={{ height: 120 }} />}

      {items !== null && upcoming.length === 0 && (
        <section className="card empty">
          <h2>No events planned</h2>
          <p className="muted">
            {isOfficer ? "Schedule one so members can sign up." : "Officers post Foundry, Bear and SvS here."}
          </p>
        </section>
      )}

      <ul className="stack">
        {upcoming.map((event) => (
          <li key={event.eventId}>
            <EventCard
              event={event}
              onAnswered={dataChanged}
              accountId={account?.playerId}
              isOfficer={isOfficer}
              onEdit={setEditing}
              onConfigure={setConfiguring}
            />
          </li>
        ))}
      </ul>

      {past.length > 0 && (
        <>
          <h2 className="section-label">{showHistory ? "Event history" : "Recent"}</h2>
          <ul className="stack">
            {past.map((event) => (
              <li key={event.eventId}>
                <EventCard
                  event={event}
                  onAnswered={dataChanged}
                  accountId={account?.playerId}
                  isOfficer={isOfficer}
                  onConfigure={setConfiguring}
                  past
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        type="button"
        className="btn btn-secondary btn-block"
        onClick={() => {
          setItems(null);
          setShowHistory((shown) => !shown);
        }}
      >
        {showHistory ? "Show recent events only" : "Show full event history"}
      </button>

      <Sheet open={creating} title="New event" onClose={() => setCreating(false)}>
        <EventForm
          onDone={() => {
            setCreating(false);
            dataChanged();
          }}
        />
      </Sheet>

      <Sheet open={editing !== null} title="Edit event" onClose={() => setEditing(null)}>
        {editing && (
          <EventForm
            event={editing}
            onDone={() => {
              setEditing(null);
              dataChanged();
            }}
          />
        )}
      </Sheet>

      <Sheet open={configuring !== null} title="Configure result session" onClose={() => setConfiguring(null)}>
        {configuring && (
          <LegacySessionForm
            event={configuring}
            onDone={() => {
              setConfiguring(null);
              dataChanged();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function EventCard({
  event,
  accountId,
  isOfficer,
  onAnswered,
  onEdit,
  onConfigure,
  past = false,
}: {
  event: EventListItem;
  accountId: string | undefined;
  isOfficer: boolean;
  onAnswered: () => void;
  onEdit?: (event: EventListItem) => void;
  onConfigure?: (event: EventListItem) => void;
  past?: boolean;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [answer, setAnswer] = useState<Answer | null>(event.myAnswer);
  const [session, setSession] = useState<string | null>(event.mySessionId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<EventDetail | null>(null);

  useEffect(() => {
    setAnswer(event.myAnswer);
    setSession(event.mySessionId);
  }, [event.myAnswer, event.mySessionId]);

  /** Picking a legion replaces an earlier pick: nobody is in two legions of one battle. */
  const choose = async (value: Answer, sessionId?: string) => {
    if (!accountId) return;
    if (value === answer && (sessionId ?? null) === session) return;
    const key = sessionId ?? value;
    setBusy(key);
    setError(null);
    const previous = { answer, session };
    setAnswer(value);
    setSession(sessionId ?? null);
    try {
      await api.answer(event.eventId, accountId, value, sessionId);
      const label = sessionId ? event.sessions.find((s) => s.id === sessionId)?.label : undefined;
      toast(label ? `You're in for ${label}` : value === "yes" ? "You're in" : value === "no" ? "Signup withdrawn" : "Marked as maybe");
      onAnswered();
    } catch (e) {
      setAnswer(previous.answer);
      setSession(previous.session);
      setError(e instanceof ApiError ? e.message : "Couldn't save your answer.");
    } finally {
      setBusy(null);
    }
  };

  const showDetails = async () => {
    setError(null);
    try {
      setDetails(await api.event(event.eventId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the details.");
    }
  };

  return (
    <article className={`card event${past ? " event-past" : ""}`}>
      <div className="event-head">
        <span className="badge">{kindLabel(event.kind)}</span>
        <span className="muted small">{event.closed ? "Answers closed" : `Answers close ${untilText(event.deadlineAt)}`}</span>
      </div>
      <h3 className="event-title">
        <button type="button" className="link-btn" onClick={() => navigate(`/events/${event.eventId}`)}>
          {event.title}
        </button>
      </h3>
      <p className="muted">
        {event.sessions.length > 0
          ? `${dayTime(event.sessions[0]!.startsAt)}${event.sessions.length > 1 ? ` and ${shortTime(event.sessions.at(-1)!.startsAt)}` : ""}`
          : dayTime(event.startsAt)}
        {!past && ` · ${untilText(event.startsAt)}`}
      </p>
      {event.notes && <p className="event-notes">{event.notes}</p>}

      {!accountId ? (
        <p className="muted small">Pick a game account to answer.</p>
      ) : event.sessions.length > 0 ? (
        <div className="segmented answers" role="radiogroup" aria-label={`Your answer for ${event.title}`}>
          {event.sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={answer === "yes" && session === s.id}
              disabled={event.closed || busy !== null}
              onClick={() => void choose("yes", s.id)}
            >
              {busy === s.id ? "…" : `${s.label} · ${shortTime(s.startsAt)}`}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={answer === "no"}
            disabled={event.closed || busy !== null}
            onClick={() => void choose("no")}
          >
            {busy === "no" ? "…" : "Not signed up"}
          </button>
        </div>
      ) : (
        <div className="segmented answers" role="radiogroup" aria-label={`Your answer for ${event.title}`}>
          {ANSWERS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={answer === a.value}
              disabled={event.closed || busy !== null}
              onClick={() => void choose(a.value)}
            >
              {busy === a.value ? "…" : a.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      {isOfficer && onEdit && (
        <button type="button" className="text-btn" onClick={() => onEdit(event)}>
          Edit event
        </button>
      )}


      {isOfficer && event.kind === "foundry" && event.sessions.length === 0 && onConfigure && (
        <button type="button" className="text-btn" onClick={() => onConfigure(event)}>
          Configure result session
        </button>
      )}

      {isOfficer &&
        (details ? (
          <EventBreakdown detail={details} />
        ) : (
          <button type="button" className="text-btn" onClick={() => void showDetails()}>
            Who's coming?
          </button>
        ))}
    </article>
  );
}

/** Repairs one of the old separate L1/L2 events and keeps all existing signups attached. */
function LegacySessionForm({ event, onDone }: { event: EventListItem; onDone: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const titleLegion = event.title.match(/(?:legion\s*|\bL)([12])\b/i)?.[1];
  const [id, setId] = useState(titleLegion === "2" ? "L2" : "L1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.configureEventSession(event.eventId, {
        id,
        label: id === "L1" ? "Legion 1" : "Legion 2",
      });
      toast(`Session configured · ${result.assignedSignups} signup${result.assignedSignups === 1 ? "" : "s"} assigned`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't configure the result session.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">
        Choose the legion represented by this old event. Every existing Yes signup will be assigned to it, so bot result
        previews keep the participant list intact.
      </p>
      <div className="field">
        <label htmlFor="legacy-legion">Legion</label>
        <select id="legacy-legion" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="L1">Legion 1</option>
          <option value="L2">Legion 2</option>
        </select>
      </div>
      <div className="field">
        <span className="hint">The session will use the existing event time: {dayTime(event.startsAt)}.</span>
      </div>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Configuring…" : "Configure session"}
      </button>
    </form>
  );
}

function EventBreakdown({ detail }: { detail: EventDetail }) {
  const groups: { key: string; label: string; match: (m: EventMember) => boolean }[] =
    detail.sessions.length > 0
      ? [
          ...detail.sessions.map((s) => ({
            key: s.id,
            label: `${s.label} (${detail.counts.bySession[s.id] ?? 0})`,
            match: (m: EventMember) => m.answer === "yes" && m.sessionId === s.id,
          })),
          { key: "no", label: `Can't (${detail.counts.no})`, match: (m: EventMember) => m.answer === "no" },
          { key: "pending", label: `No answer (${detail.counts.pending})`, match: (m: EventMember) => m.answer === null },
        ]
      : [
          { key: "yes", label: `Yes (${detail.counts.yes})`, match: (m: EventMember) => m.answer === "yes" },
          { key: "maybe", label: `Maybe (${detail.counts.maybe})`, match: (m: EventMember) => m.answer === "maybe" },
          { key: "no", label: `No (${detail.counts.no})`, match: (m: EventMember) => m.answer === "no" },
          { key: "pending", label: `No answer (${detail.counts.pending})`, match: (m: EventMember) => m.answer === null },
        ];
  const [filter, setFilter] = useState<string>(groups[0]!.key);
  const members = detail.members ?? [];
  const match = groups.find((g) => g.key === filter)?.match;
  const shown = match ? members.filter(match) : [];

  return (
    <div className="event-breakdown">
      <div className="segmented" role="radiogroup" aria-label="Show members by answer">
        {groups.map(({ key, label }) => (
          <button key={key} type="button" role="radio" aria-checked={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="muted small">Nobody in this group.</p>
      ) : (
        <ul className="member-chips">
          {shown.map((m) => (
            <li key={m.playerId} className="chip-static">
              {m.name}
              {m.rank && <span className="muted"> · {m.rank}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Officers schedule an event, or change one. Times are in the officer's own time zone. */
function EventForm({ event, onDone }: { event?: EventListItem; onDone: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const editing = event !== undefined;
  const [kind, setKind] = useState<EventKind>(event?.kind ?? "foundry");
  const [title, setTitle] = useState(event?.title ?? "");
  const [startsAt, setStartsAt] = useState(event ? toLocalInput(event.startsAt) : "");
  // Foundry runs two legions in one event; everyone picks one.
  const [sessions, setSessions] = useState<{ id?: string; label: string; startsAt: string }[]>(
    event
      ? event.sessions.map((s) => ({ id: s.id, label: s.label, startsAt: toLocalInput(s.startsAt) }))
      : defaultSessions("foundry"),
  );
  const [leadDays, setLeadDays] = useState<number>(event ? leadDaysOf(event) : DEFAULT_LEAD.foundry);
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesSessions = sessions.length > 0;
  const sessionTimes = sessions.map((s) => (s.startsAt ? new Date(s.startsAt) : null));
  const sessionsValid = usesSessions && sessionTimes.every((d) => d !== null && !Number.isNaN(d.getTime()));
  // With legions the event starts when the first one does; otherwise the single start applies.
  const start = usesSessions
    ? sessionsValid
      ? new Date(Math.min(...sessionTimes.map((d) => d!.getTime())))
      : null
    : startsAt
      ? new Date(startsAt)
      : null;
  const startValid = start !== null && !Number.isNaN(start.getTime());
  const ready = title.trim().length >= 3 && startValid && (editing || start.getTime() > Date.now());
  const deadline = startValid ? previewDeadline(start, leadDays) : null;

  const chooseKind = (value: EventKind) => {
    setKind(value);
    if (editing) return;
    setLeadDays(DEFAULT_LEAD[value]); // a new event follows its type
    setSessions(defaultSessions(value));
  };

  const setSession = (index: number, patch: Partial<{ label: string; startsAt: string }>) =>
    setSessions((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !start) return;
    setBusy(true);
    setError(null);
    const body = {
      kind,
      title: title.trim(),
      startsAt: start.toISOString(),
      ...(usesSessions
        ? {
            sessions: sessions.map((s) => ({
              ...(s.id ? { id: s.id } : {}),
              label: s.label.trim(),
              startsAt: new Date(s.startsAt).toISOString(),
            })),
          }
        : {}),
      answersCloseDaysBefore: leadDays,
      timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
      notes: notes.trim(),
    };
    try {
      if (editing) await api.updateEvent(event.eventId, body);
      else await api.createEvent(body);
      toast(editing ? "Event updated" : "Event created");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the event.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <fieldset className="field">
        <legend>Type</legend>
        <div className="chips" role="radiogroup">
          {KINDS.map((k) => (
            <label key={k.value} className="chip">
              <input type="radio" name="kind" value={k.value} checked={kind === k.value} onChange={() => chooseKind(k.value)} />
              <span>{k.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="e-title">Title</label>
        <input
          id="e-title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Foundry — Legion 1"
        />
      </div>

      {usesSessions ? (
        <fieldset className="field">
          <legend>Legions</legend>
          <span className="hint">One event, two battles. Everyone signs up for one of them.</span>
          {sessions.map((s, i) => (
            <div key={s.id ?? i} className="session-row">
              <input
                aria-label={`Name of part ${i + 1}`}
                value={s.label}
                onChange={(e) => setSession(i, { label: e.target.value })}
                placeholder={`Legion ${i + 1}`}
              />
              <input
                aria-label={`Start of ${s.label || `part ${i + 1}`}`}
                type="datetime-local"
                value={s.startsAt}
                onChange={(e) => setSession(i, { startsAt: e.target.value })}
              />
            </div>
          ))}
        </fieldset>
      ) : (
        <div className="field">
          <label htmlFor="e-start">Starts</label>
          <input id="e-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <span className="hint">Your local time.</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="e-lead">Answers close</label>
        <select id="e-lead" value={leadDays} onChange={(e) => setLeadDays(Number(e.target.value))}>
          {LEAD_CHOICES.map((c) => (
            <option key={c.days} value={c.days}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="hint">
          {deadline
            ? `Closes ${dayTime(deadline.toISOString())}${deadline.getTime() < Date.now() ? " — already past, so answers stay closed" : ""}`
            : "Foundry closes three days before, so officers can register people in game."}
        </span>
      </div>

      <div className="field">
        <label htmlFor="e-notes">Notes (optional)</label>
        <textarea id="e-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bring traps" />
      </div>

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !ready}>
        {busy ? "Saving…" : editing ? "Save changes" : "Create event"}
      </button>
    </form>
  );
}
