import { useEffect, useMemo, useState } from "react";
import { ApiError, type BuffDayView, type MinistryBooking, type MinistrySlotProtection, type SvsRoundDetail } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { useToast } from "../components/Toast";
import { shortDate } from "../format";
import { navigate } from "../router";
import { useSession } from "../session";

const BUFF_LABEL: Record<string, string> = {
  construction: "Vice President · Construction",
  research: "Vice President · Research",
  training: "Minister of Education · Troop training",
};

export function Svs({ roundId }: { roundId: string }) {
  const { api, account, isOfficer, dataVersion, dataChanged } = useSession();
  const [round, setRound] = useState<SvsRoundDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.svsRound(roundId).then(setRound).catch((reason: Error) => setError(reason.message));
  }, [api, roundId, dataVersion]);

  if (error && !round) return <ErrorBanner message={error} onRetry={() => navigate("/")} />;
  if (!round) return <div className="card skeleton" style={{ height: 260 }} />;

  const book = async (dayId: string, slot: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.bookMinistrySlot(roundId, dayId, slot);
      toast("Your Ministry appointment is booked");
      dataChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Couldn't book that time.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (booking: MinistryBooking) => {
    setBusy(true);
    try {
      await api.cancelMinistryBooking(booking);
      toast("Appointment cancelled");
      dataChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Couldn't cancel that appointment.");
    } finally {
      setBusy(false);
    }
  };

  const setBookingEnabled = async (enabled: boolean) => {
    if (!enabled && !window.confirm("Hide this Ministry signup from POP members and guests? Existing bookings will be preserved.")) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.setMinistryBookingEnabled(roundId, enabled);
      toast(enabled ? "Ministry signup enabled" : "Ministry signup hidden");
      dataChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Couldn't change Ministry signup availability.");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <button type="button" className="text-btn" onClick={() => navigate("/")}>‹ Home</button>
    <div className="page-head ministry-title-row">
      <div>
        <span className="section-label">Two-week Ministry term</span>
        <h1 className="page-title">{round.label}</h1>
        <p className="muted">{dateRange(round.term.startsOn, round.term.endsOn)} · times shown in your local time</p>
      </div>
      <span className={`pill ${round.bookingEnabled ? "pill-up" : ""}`}>{round.bookingEnabled ? "Booking open" : "Booking off"}</span>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {isOfficer && <section className={`card ministry-availability ${round.bookingEnabled ? "" : "ministry-availability-off"}`}>
      <span>
        <strong>{round.bookingEnabled ? "POP currently holds the Ministry" : "POP does not currently hold the Ministry"}</strong>
        <small className="muted">{round.bookingEnabled ? "Members and guests can see and claim free appointments." : "This term is hidden and booking is blocked for members and guests."}</small>
      </span>
      <button type="button" className={`btn btn-small ${round.bookingEnabled ? "btn-quiet" : "btn-primary"}`} disabled={busy} onClick={() => void setBookingEnabled(!round.bookingEnabled)}>
        {round.bookingEnabled ? "Disable signup" : "Enable signup"}
      </button>
    </section>}
    {round.bookingEnabled && !account && <p className="banner banner-warn">Choose a linked POP account before booking.</p>}
    <section className="ministry-explainer card">
      <strong>{round.bookingEnabled ? "Pick a free time and it is yours." : "Signup is currently disabled."}</strong>
      <span className="muted">{round.bookingEnabled ? "Occupied appointments are hidden. Each account can hold one appointment per Ministry day." : "An R4 or R5 can enable it when POP controls the State Ministry again."}</span>
    </section>
    {isOfficer && <RallyLeadProtection round={round} disabled={busy} onSave={async (protections) => {
      setBusy(true);
      try { await api.setMinistryProtections(roundId, protections); toast("Rally-lead times updated"); dataChanged(); }
      catch (reason) { setError(reason instanceof ApiError ? reason.message : "Couldn't reserve those times."); }
      finally { setBusy(false); }
    }} />}
    <div className="stack ministry-days">
      {round.days.map((day) => {
        const booking = round.yourBookings.find((item) => item.dayId === day.id);
        return <MinistryDayCard key={day.id} day={day} {...(booking ? { booking } : {})} disabled={busy || !account || !round.bookingEnabled} onBook={book} onCancel={cancel} />;
      })}
    </div>
    {round.bookingEnabled && <a className="card ministry-guest-share" href={`/ministry/${round.roundId}`}>
      <span><strong>Booking for another alliance?</strong><span className="muted small">Open the guest form or share this page.</span></span>
      <span className="chevron">›</span>
    </a>}
  </>;
}

function MinistryDayCard({ day, booking, disabled, onBook, onCancel }: {
  day: BuffDayView;
  booking?: MinistryBooking;
  disabled: boolean;
  onBook: (dayId: string, slot: number) => Promise<void>;
  onCancel: (booking: MinistryBooking) => Promise<void>;
}) {
  const [period, setPeriod] = useState<"morning" | "afternoon" | "evening">("evening");
  const slots = useMemo(() => (day.freeSlots ?? []).filter((slot) => periodOf(day, slot) === period), [day, period]);
  return <section className="card ministry-day-card">
    <div className="event-head">
      <div><h2 className="event-title">{BUFF_LABEL[day.buff] ?? day.buff}</h2><p className="muted">{shortDate(day.startsAt)}</p></div>
      {booking && <span className="pill pill-up">Booked</span>}
    </div>
    {booking ? <div className="ministry-confirmed">
      <div><span className="section-label">Your appointment</span><strong>{slotDateTime(day, booking.slot)}</strong><span className="muted small">UTC {utcTime(day, booking.slot)} · reminder delivery is coming later</span></div>
      <button type="button" className="btn btn-quiet btn-small" disabled={disabled} onClick={() => void onCancel(booking)}>Cancel</button>
    </div> : <>
      <div className="ministry-periods" role="tablist" aria-label="Time of day">
        {(["morning", "afternoon", "evening"] as const).map((value) => <button key={value} type="button" aria-selected={period === value} onClick={() => setPeriod(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </div>
      {slots.length > 0 ? <div className="ministry-free-slots">
        {slots.map((slot) => <button key={slot} type="button" className={(day.prioritySlots ?? []).includes(slot) ? "ministry-priority-slot" : ""} disabled={disabled} onClick={() => void onBook(day.id, slot)}><strong>{localTime(day, slot)}</strong><span>{(day.prioritySlots ?? []).includes(slot) ? "Rally lead priority" : "Free"}</span></button>)}
      </div> : <p className="ministry-no-slots muted">No free times in this part of the day.</p>}
    </>}
  </section>;
}

function RallyLeadProtection({ round, disabled, onSave }: { round: SvsRoundDetail; disabled: boolean; onSave: (protections: MinistrySlotProtection[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [dayId, setDayId] = useState(round.days[0]?.id ?? "");
  const [from, setFrom] = useState(36);
  const [to, setTo] = useState(39);
  const [label, setLabel] = useState("Special event rally leads");
  const [players, setPlayers] = useState("");
  const [release, setRelease] = useState("");
  const protections = round.protections ?? [];
  if (!open) return <button type="button" className="text-btn ministry-protection-toggle" onClick={() => setOpen(true)}>Manage rally-lead priority times{protections.length ? ` (${protections.length})` : ""}</button>;
  const day = round.days.find((item) => item.id === dayId) ?? round.days[0]!;
  const ids = players.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean);
  const canAdd = label.trim().length >= 3 && ids.length > 0 && release && from <= to;
  const add = async () => {
    if (!canAdd) return;
    await onSave([...protections, { protectionId: crypto.randomUUID(), dayId, slots: Array.from({ length: to - from + 1 }, (_, index) => from + index), label: label.trim(), eligiblePlayerIds: ids, releasesAt: new Date(release).toISOString() }]);
  };
  return <section className="card stack ministry-protection-manager">
    <div className="event-head"><div><h2 className="event-title">Rally-lead priority times</h2><p className="muted small">Hidden from everyone else until the release time, then automatically public.</p></div><button type="button" className="text-btn" onClick={() => setOpen(false)}>Close</button></div>
    {protections.map((protection) => <div key={protection.protectionId} className="ministry-protection-row"><span><strong>{protection.label}</strong><small>{protection.eligiblePlayerIds.length} eligible · releases {new Date(protection.releasesAt).toLocaleString()}</small></span><button type="button" className="text-btn danger" disabled={disabled} onClick={() => void onSave(protections.filter((item) => item.protectionId !== protection.protectionId))}>Remove</button></div>)}
    <div className="ministry-protection-form">
      <label className="field"><span>Ministry day</span><select value={dayId} onChange={(event) => setDayId(event.target.value)}>{round.days.map((item) => <option key={item.id} value={item.id}>{BUFF_LABEL[item.buff]}</option>)}</select></label>
      <label className="field"><span>From</span><select value={from} onChange={(event) => setFrom(Number(event.target.value))}>{Array.from({ length: 48 }, (_, slot) => <option key={slot} value={slot}>{localTime(day, slot)}</option>)}</select></label>
      <label className="field"><span>Through</span><select value={to} onChange={(event) => setTo(Number(event.target.value))}>{Array.from({ length: 48 }, (_, slot) => <option key={slot} value={slot}>{localTime(day, slot)}</option>)}</select></label>
      <label className="field ministry-protection-wide"><span>Reason shown to eligible players</span><input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="field ministry-protection-wide"><span>Eligible rally-lead Player IDs</span><input value={players} onChange={(event) => setPlayers(event.target.value)} placeholder="Separate IDs with commas" /></label>
      <label className="field ministry-protection-wide"><span>Release to everyone</span><input type="datetime-local" value={release} onChange={(event) => setRelease(event.target.value)} /></label>
    </div>
    <button type="button" className="btn btn-primary btn-small" disabled={disabled || !canAdd} onClick={() => void add()}>Protect these times</button>
  </section>;
}

export const slotInstant = (day: Pick<BuffDayView, "startsAt">, slot: number) => new Date(Date.parse(day.startsAt) + slot * 30 * 60_000);
export const localTime = (day: Pick<BuffDayView, "startsAt">, slot: number) => slotInstant(day, slot).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const utcTime = (day: Pick<BuffDayView, "startsAt">, slot: number) => slotInstant(day, slot).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const slotDateTime = (day: Pick<BuffDayView, "startsAt">, slot: number) => slotInstant(day, slot).toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" });
const periodOf = (day: Pick<BuffDayView, "startsAt">, slot: number) => {
  const hour = slotInstant(day, slot).getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
};
export const ministryDateRange = (start: string, end: string) => `${new Date(`${start}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short" })}–${new Date(`${end}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`;
const dateRange = ministryDateRange;
