import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  bookGuestMinistrySlot,
  cancelGuestMinistryBooking,
  inspectGuestMinistryBooking,
  publicMinistryTerm,
  publicMinistryTerms,
  type GuestMinistryBookingView,
  type PublicMinistryDay,
  type PublicMinistryTerm,
} from "../api";
import { localTime, ministryDateRange, slotDateTime, utcTime } from "./Svs";

const LABELS: Record<string, string> = {
  construction: "Vice President · Construction",
  research: "Vice President · Research",
  training: "Minister of Education · Troop training",
};

let capturedManageToken: string | undefined;
if (window.location.pathname === "/ministry/manage" && window.location.hash.length > 1) {
  capturedManageToken = window.location.hash.slice(1);
  window.history.replaceState(window.history.state, "", "/ministry/manage");
}

export function GuestMinistry({ roundId, manage = false }: { roundId?: string; manage?: boolean }) {
  if (manage) return <GuestBookingManager />;
  return roundId ? <GuestBooking roundId={roundId} /> : <GuestBooking />;
}

function GuestBooking({ roundId }: { roundId?: string }) {
  const [terms, setTerms] = useState<PublicMinistryTerm[]>();
  const [term, setTerm] = useState<PublicMinistryTerm>();
  const [choice, setChoice] = useState<{ day: PublicMinistryDay; slot: number }>();
  const [playerId, setPlayerId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [alliance, setAlliance] = useState("");
  const [result, setResult] = useState<(GuestMinistryBookingView & { token: string })>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = roundId ? publicMinistryTerm(roundId).then(setTerm) : publicMinistryTerms().then((value) => setTerms(value.items));
    load.catch((reason: Error) => setError(reason.message));
  }, [roundId]);

  if (result) return <GuestConfirmation result={result} />;
  if (error && !term && !terms) return <GuestShell><p className="banner banner-error">{error}</p></GuestShell>;
  if (!roundId) return <GuestShell>
    <span className="section-label">State 2612 Ministries</span>
    <h1>Book a Ministry appointment</h1>
    <p className="muted">Choose the current two-week term. You will only see appointments that are still free.</p>
    {!terms ? <div className="card skeleton" style={{ height: 140 }} /> : terms.length === 0 ? <div className="card empty"><h2>No booking term is open</h2><p className="muted">Check back when the next Ministry schedule opens.</p></div> : <div className="stack">
      {terms.map((item) => <a key={item.roundId} className="card ministry-term-link" href={`/ministry/${item.roundId}`}><span><strong>{item.label}</strong><small>{ministryDateRange(item.term.startsOn, item.term.endsOn)}</small></span><span className="chevron">›</span></a>)}
    </div>}
    <a className="text-btn center-block" href="/ministry/manage">Already booked? Open your private link</a>
  </GuestShell>;
  if (!term) return <GuestShell><div className="card skeleton" style={{ height: 260 }} /></GuestShell>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!choice) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await bookGuestMinistrySlot(term.roundId, { playerId, playerName, alliance, dayId: choice.day.id, slot: choice.slot }));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Couldn't book that appointment.");
      if (reason instanceof ApiError && reason.status === 409) setChoice(undefined);
    } finally {
      setBusy(false);
    }
  };

  return <GuestShell>
    <a className="text-btn" href="/ministry">‹ Ministry terms</a>
    <span className="section-label">Guest booking · State 2612</span>
    <h1>{term.label}</h1>
    <p className="muted">{ministryDateRange(term.term.startsOn, term.term.endsOn)} · no account required</p>
    <div className="ministry-guest-steps"><span className={!choice ? "active" : "done"}>1. Pick a free time</span><span className={choice ? "active" : ""}>2. Your game details</span></div>
    {!choice ? <div className="stack">{term.days.map((day) => <GuestDay key={day.id} day={day} onPick={(slot) => setChoice({ day, slot })} />)}</div> : <form className="card form ministry-guest-form" onSubmit={(event) => void submit(event)}>
      <button type="button" className="ministry-selected-time" onClick={() => setChoice(undefined)}><span><small>Your selected appointment</small><strong>{LABELS[choice.day.buff]}</strong><span>{slotDateTime(choice.day, choice.slot)} · UTC {utcTime(choice.day, choice.slot)}</span></span><span>Change</span></button>
      <label className="field"><span>Player ID</span><input required inputMode="numeric" pattern="[0-9]{6,20}" value={playerId} onChange={(event) => setPlayerId(event.target.value.replace(/\D/g, ""))} placeholder="From your game profile" /></label>
      <label className="field"><span>In-game name</span><input required minLength={2} maxLength={40} value={playerName} onChange={(event) => setPlayerName(event.target.value)} /></label>
      <label className="field"><span>Alliance tag</span><input required minLength={2} maxLength={12} autoCapitalize="characters" value={alliance} onChange={(event) => setAlliance(event.target.value.toUpperCase())} placeholder="e.g. POP" /></label>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy || playerId.length < 6 || playerName.trim().length < 2 || alliance.trim().length < 2}>{busy ? "Booking…" : "Book this appointment"}</button>
      <p className="muted small center">We create no login, email address or password. You will receive a private management link.</p>
    </form>}
  </GuestShell>;
}

function GuestDay({ day, onPick }: { day: PublicMinistryDay; onPick: (slot: number) => void }) {
  const [show, setShow] = useState(false);
  const useful = useMemo(() => day.freeSlots.filter((slot) => {
    const hour = new Date(Date.parse(day.startsAt) + slot * 30 * 60_000).getHours();
    return hour >= 8 && hour < 24;
  }), [day]);
  return <section className="card ministry-guest-day">
    <button type="button" className="ministry-day-toggle" onClick={() => setShow(!show)}><span><strong>{LABELS[day.buff]}</strong><small>{new Date(day.startsAt).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</small></span><span>{useful.length} free <b>{show ? "⌃" : "⌄"}</b></span></button>
    {show && <div className="ministry-free-slots">{useful.map((slot) => <button type="button" key={slot} onClick={() => onPick(slot)}><strong>{localTime(day, slot)}</strong><span>Free</span></button>)}</div>}
  </section>;
}

function GuestConfirmation({ result }: { result: GuestMinistryBookingView & { token: string } }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/ministry/manage#${result.token}`;
  return <GuestShell>
    <div className="success-mark">✓</div><span className="section-label">Appointment confirmed</span><h1>Save your private link</h1>
    <section className="card ministry-confirmation-card"><span>{LABELS[result.day.buff]}</span><strong>{slotDateTime({ startsAt: `${result.day.date}T00:00:00.000Z` }, result.booking.slot)}</strong><small>UTC {utcTime({ startsAt: `${result.day.date}T00:00:00.000Z` }, result.booking.slot)} · {result.booking.playerName} · {result.booking.alliance}</small></section>
    <p className="muted">Use this link to return to your appointment or cancel it. It is private—anyone with it can manage your booking. It expires {new Date(result.manageUntil).toLocaleDateString()}.</p>
    <button type="button" className="btn btn-primary btn-block" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? "Private link copied" : "Copy private booking link"}</button>
    <p className="banner banner-warn small">Notifications are not available yet. Save this link; Discord and email reminders are planned for a later release.</p>
  </GuestShell>;
}

function GuestBookingManager() {
  const [view, setView] = useState<GuestMinistryBookingView>();
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (!capturedManageToken) { setError("Open the private link you received after booking."); return; }
    inspectGuestMinistryBooking(capturedManageToken).then(setView).catch((reason: Error) => setError(reason.message));
  }, []);
  const cancel = async () => {
    if (!capturedManageToken || !window.confirm("Cancel this Ministry appointment? The time will become available to someone else.")) return;
    try { await cancelGuestMinistryBooking(capturedManageToken); capturedManageToken = undefined; setCancelled(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't cancel."); }
  };
  return <GuestShell>
    <span className="section-label">Private booking</span><h1>Your Ministry appointment</h1>
    {cancelled ? <div className="card empty"><h2>Appointment cancelled</h2><p className="muted">The time is free again.</p><a className="btn btn-primary" href="/ministry">Book another time</a></div> : error ? <p className="banner banner-error">{error}</p> : !view ? <div className="card skeleton" style={{ height: 180 }} /> : <>
      <section className="card ministry-confirmation-card"><span>{LABELS[view.day.buff]}</span><strong>{slotDateTime({ startsAt: `${view.day.date}T00:00:00.000Z` }, view.booking.slot)}</strong><small>UTC {utcTime({ startsAt: `${view.day.date}T00:00:00.000Z` }, view.booking.slot)} · {view.booking.playerName} · {view.booking.alliance}</small></section>
      <p className="muted">This booking belongs to the {ministryDateRange(view.term.startsOn, view.term.endsOn)} term.</p>
      <button type="button" className="btn btn-danger btn-block" onClick={() => void cancel()}>Cancel appointment</button>
      <p className="muted small center">Discord and email reminders are planned but are not active yet.</p>
    </>}
  </GuestShell>;
}

function GuestShell({ children }: { children: ReactNode }) {
  return <main className="signin ministry-public-page"><section className="signin-card ministry-public-card"><img className="signin-logo" src="/pop-logo.png" alt="POP HQ" />{children}</section></main>;
}
