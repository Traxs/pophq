import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type Answer, type EventDetail, type EventListItem, type EventKind } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { dayTime, untilText } from "../format";
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

export function Events() {
  const { api, me, account, isOfficer, dataVersion, dataChanged } = useSession();
  const [items, setItems] = useState<EventListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .events()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, dataVersion, attempt]);

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
            <EventCard event={event} onAnswered={dataChanged} accountId={account?.playerId} isOfficer={isOfficer} />
          </li>
        ))}
      </ul>

      {past.length > 0 && (
        <>
          <h2 className="section-label">Recent</h2>
          <ul className="stack">
            {past.map((event) => (
              <li key={event.eventId}>
                <EventCard event={event} onAnswered={dataChanged} accountId={account?.playerId} isOfficer={isOfficer} past />
              </li>
            ))}
          </ul>
        </>
      )}

      <Sheet open={creating} title="New event" onClose={() => setCreating(false)}>
        <EventForm
          onDone={() => {
            setCreating(false);
            dataChanged();
          }}
        />
      </Sheet>
    </>
  );
}

function EventCard({
  event,
  accountId,
  isOfficer,
  onAnswered,
  past = false,
}: {
  event: EventListItem;
  accountId: string | undefined;
  isOfficer: boolean;
  onAnswered: () => void;
  past?: boolean;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [answer, setAnswer] = useState<Answer | null>(event.myAnswer);
  const [busy, setBusy] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<EventDetail | null>(null);

  useEffect(() => setAnswer(event.myAnswer), [event.myAnswer]);

  const choose = async (value: Answer) => {
    if (!accountId || value === answer) return;
    setBusy(value);
    setError(null);
    const previous = answer;
    setAnswer(value); // optimistic: the buttons react immediately
    try {
      await api.answer(event.eventId, accountId, value);
      toast(value === "yes" ? "You're in" : value === "no" ? "Marked as not coming" : "Marked as maybe");
      onAnswered();
    } catch (e) {
      setAnswer(previous);
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
      <h3 className="event-title">{event.title}</h3>
      <p className="muted">
        {dayTime(event.startsAt)}
        {!past && ` · ${untilText(event.startsAt)}`}
      </p>
      {event.notes && <p className="event-notes">{event.notes}</p>}

      {!accountId ? (
        <p className="muted small">Pick a game account to answer.</p>
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

function EventBreakdown({ detail }: { detail: EventDetail }) {
  const [filter, setFilter] = useState<Answer | "pending">("yes");
  const members = detail.members ?? [];
  const shown = useMemo(
    () => members.filter((m) => (filter === "pending" ? m.answer === null : m.answer === filter)),
    [members, filter],
  );
  const { counts } = detail;

  return (
    <div className="event-breakdown">
      <div className="segmented" role="radiogroup" aria-label="Show members by answer">
        {(
          [
            ["yes", `Yes (${counts.yes})`],
            ["maybe", `Maybe (${counts.maybe})`],
            ["no", `No (${counts.no})`],
            ["pending", `No answer (${counts.pending})`],
          ] as const
        ).map(([key, label]) => (
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

/** Officers schedule an event. Times are entered in the officer's own time zone. */
function EventForm({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<EventKind>("foundry");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = startsAt ? new Date(startsAt) : null;
  const startValid = start !== null && !Number.isNaN(start.getTime()) && start.getTime() > Date.now();
  const ready = title.trim().length >= 3 && startValid;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !start) return;
    setBusy(true);
    setError(null);
    try {
      await api.createEvent({
        kind,
        title: title.trim(),
        startsAt: start.toISOString(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast("Event created");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the event.");
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
              <input type="radio" name="kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} />
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
          placeholder="Foundry Saturday"
        />
      </div>

      <div className="field">
        <label htmlFor="e-start">Starts</label>
        <input id="e-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        <span className="hint">Your local time. Answers close an hour before the start.</span>
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
        {busy ? "Creating…" : "Create event"}
      </button>
    </form>
  );
}
