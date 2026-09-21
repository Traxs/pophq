import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type Answer, type EventDetail, type EventListItem, type EventKind, type EventMember } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { compact, dayTime, full, relativeDay, shortTime, untilText } from "../format";
import { latestKnown, sortForBreakdown, totalsOf, valueOf } from "../eventBreakdown";
import { isReportOverdue } from "../rules";
import {
  DEFAULT_EVENT_HOURS,
  halfSpan,
  halvesFor,
  leadDaysOf,
  nextUtcNoon,
  previewDeadline,
  toLocalInput,
} from "../eventTiming";
import { navigate } from "../router";
import { useSession } from "../session";
import { NoAccount } from "./Home";

/** What officers can schedule. The Bear hunt runs every other day and needs no sign-up. */
const KINDS: { value: EventKind; label: string }[] = [
  { value: "foundry", label: "Foundry" },
  { value: "svs", label: "SvS" },
  { value: "fdt", label: "FDT" },
  { value: "canyon", label: "Canyon" },
  { value: "tundra", label: "Tundra League" },
  { value: "other", label: "Other" },
];

/** Includes kinds nobody schedules any more, so an event from the archive still reads right. */
const KIND_LABELS: Record<EventKind, string> = {
  foundry: "Foundry",
  svs: "SvS",
  fdt: "FDT",
  canyon: "Canyon",
  tundra: "Tundra League",
  bear: "Bear hunt",
  other: "Other",
};

const kindLabel = (kind: EventKind) => KIND_LABELS[kind] ?? "Event";

/** How long before the start answers close. Foundry needs days: officers sign people up in game. */
const LEAD_CHOICES = [
  { days: 3, label: "3 days before" },
  { days: 2, label: "2 days before" },
  { days: 1, label: "1 day before" },
  { days: 0, label: "1 hour before" },
];
const DEFAULT_LEAD: Record<EventKind, number> = {
  foundry: 3,
  svs: 3,
  fdt: 1,
  canyon: 1,
  tundra: 1,
  bear: 0,
  other: 0,
};
const ALL_EVENT_HISTORY = "1970-01-01T00:00:00.000Z";

/**
 * A Foundry is one event with two legions. SvS and FDT ask for how much of it someone can give,
 * which is the same mechanism: three parts, one pick. Canyon and Tundra League are a plain
 * "are you in?", so they have no parts.
 */
const HALVES = [
  { id: "full", label: "Full time", startsAt: "" },
  { id: "first", label: "First half", startsAt: "" },
  { id: "last", label: "Last half", startsAt: "" },
];

const defaultSessions = (kind: EventKind): { id?: string; label: string; startsAt: string }[] => {
  if (kind === "foundry") {
    return [
      { id: "L1", label: "Legion 1", startsAt: "" },
      { id: "L2", label: "Legion 2", startsAt: "" },
    ];
  }
  return kind === "svs" || kind === "fdt" ? HALVES.map((h) => ({ ...h })) : [];
};

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
        {(() => {
          // Halves are one sitting with a midpoint, so they read as a span; legions are separate
          // times and read as "and".
          const span = halfSpan(event.sessions);
          if (span) return `${dayTime(span.startsAt)} – ${shortTime(span.endsAt)}`;
          if (event.sessions.length === 0) return dayTime(event.startsAt);
          return `${dayTime(event.sessions[0]!.startsAt)}${event.sessions.length > 1 ? ` and ${shortTime(event.sessions.at(-1)!.startsAt)}` : ""}`;
        })()}
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
        // No parts to choose between: one button to join, and the same button to drop out again.
        <>
          <button
            type="button"
            className={answer === "yes" ? "btn btn-primary btn-block" : "btn btn-quiet btn-block"}
            aria-pressed={answer === "yes"}
            disabled={event.closed || busy !== null}
            onClick={() => void choose(answer === "yes" ? "no" : "yes")}
          >
            {busy !== null ? "…" : answer === "yes" ? "You're in — tap to drop out" : "Join"}
          </button>
          {answer === "no" && <p className="muted small">You're down as not coming.</p>}
        </>
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
          { key: "yes", label: `Joined (${detail.counts.yes})`, match: (m: EventMember) => m.answer === "yes" },
          // "Maybe" is no longer offered; the group appears only while older answers still have one.
          ...(detail.counts.maybe > 0
            ? [{ key: "maybe", label: `Maybe (${detail.counts.maybe})`, match: (m: EventMember) => m.answer === "maybe" }]
            : []),
          { key: "no", label: `Can't (${detail.counts.no})`, match: (m: EventMember) => m.answer === "no" },
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
        <BreakdownTable members={shown} pending={filter === "pending"} kind={detail.kind} />
      )}
    </div>
  );
}


/**
 * One answer group as a table. Strongest first: when a legion is short, the officer wants to know
 * which of the missing people actually matter, not just how many there are.
 */
function BreakdownTable({ members, pending, kind }: { members: EventMember[]; pending: boolean; kind: EventKind }) {
  // Foundry strength decides a Foundry; for a bear hunt or an SvS call, city power is the number
  // an officer actually weighs. The table sorts by whichever it shows.
  const foundry = kind === "foundry";
  const metric = foundry ? "foundry" : "power";
  const rows = sortForBreakdown(members, metric);
  const totals = totalsOf(rows, metric);

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Rank</th>
              <th scope="col" className="num">
                {foundry ? "Foundry" : "Power"}
              </th>
              <th scope="col" className="num">
                Attendance
              </th>
              {/* People who answered are judged on when; people who did not, on whether they are
                  around at all. */}
              <th scope="col">{pending ? "Last report" : "Answered"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const attendance = latestKnown(m.attendanceTrend);
              return (
                <tr key={m.playerId}>
                  <td>{m.name}</td>
                  <td className="muted">{m.rank ?? "–"}</td>
                  <td className="num">{valueOf(m, metric) === null ? "–" : full(valueOf(m, metric)!)}</td>
                  <td className="num">{attendance === undefined ? "–" : `${Math.round(attendance * 100)}%`}</td>
                  <td className={pending && isReportOverdue(m.lastReportAt) ? "delta-down" : undefined}>
                    {pending
                      ? m.lastReportAt
                        ? relativeDay(m.lastReportAt)
                        : "never"
                      : m.answeredAt
                        ? relativeDay(m.answeredAt)
                        : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {totals.people} {totals.people === 1 ? "person" : "people"} · {compact(totals.strength)}{" "}
        {foundry ? "Foundry strength" : "power"}
        {totals.missing > 0 && ` · ${totals.missing} never reported it`}
      </p>
    </>
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
  // SvS and FDT run about six hours; the halves follow from that rather than being typed out.
  const [hours, setHours] = useState<number>(DEFAULT_EVENT_HOURS);
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SvS and FDT: one start and a length, from which Full time / First half / Last half follow.
  const usesHalves = kind === "svs" || kind === "fdt";
  const effectiveSessions = usesHalves ? halvesFor(startsAt, hours) : sessions;
  const usesSessions = effectiveSessions.length > 0;
  const sessionTimes = effectiveSessions.map((s) => (s.startsAt ? new Date(s.startsAt) : null));
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
    // SvS and FDT normally start at 12:00 UTC, so the officer only has to pick the day.
    if ((value === "svs" || value === "fdt") && !startsAt) setStartsAt(nextUtcNoon());
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
            sessions: effectiveSessions.map((s) => ({
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
          placeholder={kindLabel(kind)}
        />
      </div>

      {usesSessions && !usesHalves ? (
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

      {usesHalves && (
        <div className="field">
          <label htmlFor="e-hours">Runs for</label>
          <select id="e-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[2, 3, 4, 6, 8, 12].map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </select>
          <span className="hint">
            {startValid
              ? `Full time and first half from ${shortTime(effectiveSessions[0]!.startsAt)}, last half from ${shortTime(effectiveSessions[2]!.startsAt)}.`
              : "Full time and first half start with the event; the last half starts halfway through."}
          </span>
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
