import type { EventKind, EventListItem } from "../api";
import { eventDayTime, untilText } from "../format";

const KIND_LABELS: Record<EventKind, string> = {
  foundry: "Foundry",
  svs: "SvS",
  koi: "King of Icefield",
  fdt: "FDT",
  canyon: "Canyon",
  tundra: "Tundra League",
  bear: "Bear hunt",
  other: "Alliance event",
};

/** Events that are upcoming and still accept a response, nearest first. */
export function activeRegistrationEvents(items: readonly EventListItem[], now = new Date()): EventListItem[] {
  return items
    .filter((event) => !event.closed && Date.parse(event.startsAt) >= now.getTime())
    .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function unansweredRegistrationEvents(items: readonly EventListItem[], now = new Date()): EventListItem[] {
  return activeRegistrationEvents(items, now).filter((event) => event.myAnswer === null);
}

export function HomeRegistrationPrompt({ events, onOpen }: { events: EventListItem[] | null | undefined; onOpen: () => void }) {
  if (events === null) return null;
  if (events === undefined) return <div className="card skeleton active-events-home-loading" aria-label="Loading active event registrations" aria-busy="true" />;

  const unanswered = unansweredRegistrationEvents(events);
  if (unanswered.length === 0) return null;
  const names = unanswered.map((event) => KIND_LABELS[event.kind]).join(" and ");

  return (
    <button type="button" className="card todo todo-due active-events-home" onClick={onOpen}>
      <span className="todo-icon" aria-hidden="true">!</span>
      <span className="todo-text">
        <strong>Register for {unanswered.length} active {unanswered.length === 1 ? "event" : "events"}</strong>
        <span className="muted">{names} {unanswered.length === 1 ? "needs" : "need"} your response.</span>
      </span>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
  );
}

export function ActiveEventRail({ events, onOpen }: { events: readonly EventListItem[]; onOpen: (eventId: string) => void }) {
  const active = activeRegistrationEvents(events);
  if (active.length === 0) return null;
  const unanswered = active.filter((event) => event.myAnswer === null);

  return (
    <aside className="card active-event-rail" aria-labelledby="active-events-title">
      <div className="active-event-rail-head">
        <span className="active-event-rail-icon" aria-hidden="true">{unanswered.length || "✓"}</span>
        <div>
          <h2 id="active-events-title">{unanswered.length === 0 ? "You’re all set" : `${unanswered.length} ${unanswered.length === 1 ? "event needs" : "events need"} your response`}</h2>
          <p className="muted small">Active registrations</p>
        </div>
      </div>
      <ul className="active-event-rail-list">
        {active.map((event) => (
          <li key={event.eventId}>
            <button type="button" onClick={() => onOpen(event.eventId)}>
              <span>
                <strong>{KIND_LABELS[event.kind]}</strong>
                <small>{eventDayTime(event.startsAt)}</small>
              </span>
              <span className={`active-event-status ${event.myAnswer === null ? "active-event-status-open" : "active-event-status-done"}`}>
                {event.myAnswer === null ? "Respond" : event.myAnswer === "no" ? "Not attending" : "Answered"}
              </span>
            </button>
            {event.myAnswer === null && <small className="active-event-deadline">Closes {untilText(event.deadlineAt)}</small>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
