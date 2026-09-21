import { useEffect, useState } from "react";
import { ApiError, type BuffDayView, type SvsRoundDetail } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { useToast } from "../components/Toast";
import {
  draftFrom,
  rankOf,
  setAnyTime,
  setUnavailable,
  slotLabel,
  spillsOver,
  summarise,
  toPayload,
  toggleSlot,
  MAX_PREFERENCES_PER_DAY,
  SLOTS_PER_DAY,
  type DayDraft,
} from "../buffSlots";
import { dayTime, shortDate, untilText } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

const BUFF_LABEL: Record<string, string> = {
  construction: "Construction",
  research: "Research",
  training: "Training",
};

/** One SvS round: when you could take a buff on each day (BUF-02). */
export function Svs({ roundId }: { roundId: string }) {
  const { api, account, dataVersion, dataChanged } = useSession();
  const [round, setRound] = useState<SvsRoundDetail | null>(null);
  const [drafts, setDrafts] = useState<DayDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .svsRound(roundId)
      .then((r) => {
        setRound(r);
        setDrafts(draftFrom(r.days, r.yourPreferences));
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, roundId, dataVersion]);

  if (error && !round) return <ErrorBanner message={error} onRetry={() => navigate("/")} />;
  if (!round) return <div className="card skeleton" style={{ height: 220 }} />;

  const open = round.state === "collecting";
  const update = (dayId: string, fn: (d: DayDraft) => DayDraft) =>
    setDrafts((current) => current.map((d) => (d.dayId === dayId ? fn(d) : d)));

  const save = async () => {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveBuffPreferences(round.roundId, account.playerId, toPayload(drafts));
      toast("Your buff times are saved");
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save your times.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button type="button" className="text-btn" onClick={() => navigate("/")}>
        ‹ Home
      </button>

      <div className="page-head">
        <h1 className="page-title">{round.label}</h1>
      </div>
      <p className="muted">
        {open
          ? `Times close ${untilText(round.preferenceDeadline)} (${dayTime(round.preferenceDeadline)})`
          : round.state === "planning"
            ? "Times are closed. Officers are assigning the slots."
            : round.state === "published"
              ? "The plan is published."
              : "This round is over."}
        {" · "}
        {round.answeredBy} {round.answeredBy === 1 ? "person has" : "people have"} answered
      </p>

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      {!account && <p className="banner banner-warn">An officer has to link your game account before you can answer.</p>}

      <ul className="stack">
        {round.days.map((day) => {
          const draft = drafts.find((d) => d.dayId === day.id);
          if (!draft) return null;
          return (
            <li key={day.id}>
              <DayCard
                day={day}
                draft={draft}
                open={open && account !== undefined}
                onToggle={(slot) => update(day.id, (d) => toggleSlot(d, slot))}
                onAnyTime={(on) => update(day.id, (d) => setAnyTime(d, on))}
                onUnavailable={(on) => update(day.id, (d) => setUnavailable(d, on))}
              />
            </li>
          );
        })}
      </ul>

      {open && account && (
        <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save my times"}
        </button>
      )}
    </>
  );
}

function DayCard({
  day,
  draft,
  open,
  onToggle,
  onAnyTime,
  onUnavailable,
}: {
  day: BuffDayView;
  draft: DayDraft;
  open: boolean;
  onToggle: (slot: number) => void;
  onAnyTime: (on: boolean) => void;
  onUnavailable: (on: boolean) => void;
}) {
  const full = draft.slots.length >= MAX_PREFERENCES_PER_DAY;
  const busiest = Math.max(1, ...day.demand);

  return (
    <article className="card stack">
      <div className="event-head">
        <h2 className="event-title">
          {BUFF_LABEL[day.buff] ?? day.buff} · {shortDate(day.startsAt)}
        </h2>
      </div>
      <p className="muted small">{summarise(draft, day)}</p>

      <div className="row-actions">
        <button
          type="button"
          className={draft.anyTime ? "btn btn-primary btn-small" : "btn btn-quiet btn-small"}
          disabled={!open}
          aria-pressed={draft.anyTime}
          onClick={() => onAnyTime(!draft.anyTime)}
        >
          Any time works
        </button>
        <button
          type="button"
          className={draft.unavailable ? "btn btn-primary btn-small" : "btn btn-quiet btn-small"}
          disabled={!open}
          aria-pressed={draft.unavailable}
          onClick={() => onUnavailable(!draft.unavailable)}
        >
          Can't this day
        </button>
      </div>

      {!draft.unavailable && !draft.anyTime && (
        <>
          <p className="muted small">
            Pick up to {MAX_PREFERENCES_PER_DAY} times, best first. Times are in your time zone;
            <strong> +1</strong> means it falls on the next day where you are.
            {full && <strong> That's three — tap one again to change it.</strong>}
          </p>
          <div className="slot-grid">
            {Array.from({ length: SLOTS_PER_DAY }, (_, slot) => {
              const rank = rankOf(draft, slot);
              const wanted = day.demand[slot] ?? 0;
              return (
                <button
                  key={slot}
                  type="button"
                  className={rank ? "slot slot-picked" : "slot"}
                  disabled={!open}
                  aria-pressed={rank !== undefined}
                  aria-label={`${slotLabel(day, slot)}${spillsOver(day, slot) ? " next day" : ""}, ${wanted} ${wanted === 1 ? "person wants" : "people want"} this time`}
                  onClick={() => onToggle(slot)}
                >
                  <span className="slot-time">
                    {slotLabel(day, slot)}
                    {/* East of UTC the later slots land on the next local day; saying so stops
                        someone picking Tuesday 01:00 while thinking of Monday. */}
                    {spillsOver(day, slot) && <span className="slot-next">+1</span>}
                  </span>
                  {rank && <span className="slot-rank">{rank}</span>}
                  {/* Demand as a quiet bar: a member can aim for an hour nobody else wants. */}
                  <span className="slot-demand" style={{ opacity: wanted === 0 ? 0 : 0.25 + (wanted / busiest) * 0.75 }} />
                </button>
              );
            })}
          </div>
        </>
      )}

      {(day.anyTime > 0 || day.unavailable > 0) && (
        <p className="muted small">
          {day.anyTime > 0 && `${day.anyTime} flexible`}
          {day.anyTime > 0 && day.unavailable > 0 && " · "}
          {day.unavailable > 0 && `${day.unavailable} can't make it`}
        </p>
      )}
    </article>
  );
}
