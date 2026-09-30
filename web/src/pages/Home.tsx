import { useEffect, useState } from "react";
import { ApiError, type CurrentRewardCycle, type EventListItem, type KudosSummary, type OfficerJob, type RewardEligibility, type SvsRoundListItem } from "../api";
import { MemberKudosCard } from "../components/MemberKudos";
import { MemberRewardCards } from "../components/MemberRewards";
import { RecentPerformance } from "../components/RecentPerformance";
import { HomePriorities } from "../components/HomePriorities";
import { useToast } from "../components/Toast";
import { change, compact, daysBetween, relativeDay } from "../format";
import { homePriorities } from "../homePriority";
import { navigate } from "../router";
import { REPORT_DUE_DAYS } from "../rules";
import { useSession } from "../session";
import { usePower } from "../usePower";
import { ChangePill } from "./Power";


export function Home() {
  const { me, account, api, isOfficer, dataVersion } = useSession();
  const { reports, latest, previous, loading, error: powerError } = usePower();
  const [registrationEvents, setRegistrationEvents] = useState<EventListItem[] | null | undefined>(undefined);
  const [recentEvents, setRecentEvents] = useState<EventListItem[] | null | undefined>(undefined);
  const [round, setRound] = useState<SvsRoundListItem | null | undefined>(undefined);
  const [officerJobs, setOfficerJobs] = useState<OfficerJob[] | null | undefined>(undefined);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    api
      .events()
      .then((r) => {
        const now = Date.now();
        setRegistrationEvents(r.items);
        setRecentEvents(r.items.filter((event) => Date.parse(event.startsAt) < now));
      })
      .catch(() => {
        setRegistrationEvents(null);
        setRecentEvents(null); // the Events page reports problems
      });
  }, [api, dataVersion]);

  useEffect(() => {
    if (!isOfficer) {
      setOfficerJobs(null);
      return;
    }
    setOfficerJobs(undefined);
    api.officerJobs().then((result) => setOfficerJobs(result.items)).catch(() => setOfficerJobs([]));
  }, [api, dataVersion, isOfficer]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    api
      .svsRounds()
      .then((r) => {
        // The round that still wants an answer comes first; otherwise the next one running.
        const live = r.items.filter((x) => x.state !== "closed");
        setRound(live.toSorted((a, b) => Number(b.state === "collecting") - Number(a.state === "collecting"))[0] ?? null);
      })
      .catch(() => setRound(null));
  }, [api, dataVersion]);

  if (me && me.accounts.length === 0) return <NoAccount />;

  const age = latest ? daysBetween(new Date(latest.effectiveAt), new Date()) : undefined;
  const due = age === undefined || age >= REPORT_DUE_DAYS;
  const delta = latest ? change(latest.power, previous?.power) : undefined;
  const powerLoaded = !loading && (reports !== null || powerError !== null);
  const prioritiesLoading = registrationEvents === undefined || round === undefined || !powerLoaded || (isOfficer && officerJobs === undefined);
  const priorities = homePriorities({
    events: registrationEvents ?? [],
    round: round ?? null,
    ...(latest ? { latestPowerAt: latest.effectiveAt } : {}),
    powerLoaded,
    officerJobs: officerJobs ?? [],
    now: clock,
  });

  return (
    <>
      <h1 className="page-title">{account ? `Hi, ${account.name}` : " "}</h1>
      <HomePriorities candidates={priorities} loading={prioritiesLoading} onOpen={navigate} />

      <section className="home-dashboard-section stack" aria-labelledby="your-status-title">
        <h2 id="your-status-title" className="section-label">Your status</h2>
        <MemberRewards />
        <MemberKudos />
        {latest && <button type="button" className="card summary" onClick={() => navigate("/power")}>
          <span className="summary-label">Power</span>
          <span className="summary-value">{compact(latest.power)}</span>
          <span className="muted small">Reported {relativeDay(latest.effectiveAt)}{!due ? ` · next update in ${REPORT_DUE_DAYS - (age ?? 0)} days` : " · update due"}</span>
          {delta && <ChangePill change={delta} since={previous!.effectiveAt} />}
        </button>}
      </section>

      <section className="home-dashboard-section stack" aria-labelledby="your-progress-title">
        <h2 id="your-progress-title" className="section-label">Your progress</h2>
        <RecentPerformance events={recentEvents} onOpen={(eventId) => navigate(`/events/${eventId}`)} onAllHistory={() => navigate("/events?history=1")} />
      </section>

      {isOfficer && <OfficerJobs jobs={officerJobs ?? []} />}

      {isOfficer && round && !round.bookingEnabled && <section className="card stack">
        <div>
          <h2 className="section-label">Ministry signup is off</h2>
          <p className="muted small">Members and guests cannot see or book this term while POP does not hold the Ministry.</p>
        </div>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate(`/svs/${round.roundId}`)}>Review Ministry term</button>
      </section>}

      {!round && isOfficer && <NewRoundCard />}
    </>
  );
}

function MemberKudos() {
  const { account, api, dataVersion } = useSession();
  const [data, setData] = useState<{ summary: KudosSummary; eligibility: RewardEligibility } | null | undefined>(undefined);

  useEffect(() => {
    if (!account) {
      setData(null);
      return;
    }
    setData(undefined);
    Promise.all([api.kudos(account.playerId), api.myRewardEligibility()])
      .then(([summary, eligibility]) => setData({ summary, eligibility }))
      .catch(() => setData(null));
  }, [account, api, dataVersion]);

  if (data === undefined) return <section className="card kudos-card eligibility-loading" aria-label="Loading fortress reward eligibility" aria-busy="true">
    <div><h2 className="section-label">Fortress reward eligibility</h2><span className="muted small">Loading your current place and calculation…</span></div>
    <div className="skeleton eligibility-loading-place" />
    <div className="skeleton eligibility-loading-calculation" />
  </section>;
  if (data === null) return null;
  return <MemberKudosCard summary={data.summary} eligibility={data.eligibility} />;
}

function MemberRewards() {
  const { api, dataVersion } = useSession();
  const [cycle, setCycle] = useState<CurrentRewardCycle | null | undefined>(undefined);

  useEffect(() => {
    api.myRewardAssignments().then((result) => setCycle(result.currentCycle)).catch(() => setCycle(null));
  }, [api, dataVersion]);

  if (!cycle || cycle.items.length === 0) return null;
  return <MemberRewardCards cycle={cycle} onAllRewards={() => navigate("/buffs")} />;
}

/**
 * What an officer still has to do (the legacy checklist, with times). Their own events first,
 * then everyone else's, so nothing quietly belongs to nobody.
 */
function OfficerJobs({ jobs }: { jobs: OfficerJob[] }) {
  const { api, dataChanged } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  if (jobs.length === 0) return null;
  const mine = jobs.filter((j) => j.mine);
  const others = jobs.filter((j) => !j.mine);

  const tick = async (job: OfficerJob) => {
    setBusy(`${job.eventId}:${job.taskId}`);
    try {
      await api.tickJob(job.eventId, job.taskId, true);
      toast("Done");
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't tick that off");
    } finally {
      setBusy(null);
    }
  };

  const row = (job: OfficerJob) => (
    <li key={`${job.eventId}:${job.taskId}`} className="job-row">
      <button
        type="button"
        className="job-tick"
        aria-label={`Done: ${job.label}`}
        disabled={busy !== null}
        onClick={() => void tick(job)}
      >
        {busy === `${job.eventId}:${job.taskId}` ? "…" : "○"}
      </button>
      <button type="button" className="job-text" onClick={() => navigate(`/events/${job.eventId}`)}>
        <strong>{job.label}</strong>
        <span className="muted">
          {job.eventTitle} ·{" "}
          {/* Late enough to be worth flagging, rather than merely a few hours past its moment. */}
          {daysBetween(new Date(job.dueAt), new Date()) >= 1 ? (
            <span className="delta-down">late, due {relativeDay(job.dueAt)}</span>
          ) : (
            `due ${relativeDay(job.dueAt)}`
          )}
          {!job.mine && job.ownerName ? ` · ${job.ownerName}'s` : !job.mine ? " · nobody's" : ""}
        </span>
      </button>
    </li>
  );

  return (
    <section className="card stack" aria-labelledby="jobs-title">
      <h2 id="jobs-title" className="section-label">
        To do as an officer
      </h2>
      {mine.length > 0 && <ul className="jobs">{mine.map(row)}</ul>}
      {others.length > 0 && (
        <>
          {mine.length > 0 && <p className="muted small">Other events</p>}
          <ul className="jobs">{others.map(row)}</ul>
        </>
      )}
    </section>
  );
}

/** Officers open the next SvS round from Home, where the missing round is most obvious (BUF-01). */
function NewRoundCard() {
  const { api, dataChanged } = useSession();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [weekStart, setWeekStart] = useState(nextMonday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="text-btn center-block" onClick={() => setOpen(true)}>
        Register for Ministry
      </button>
    );
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSvsRound({ label: label.trim(), weekStart });
      dataChanged();
      navigate(`/svs/${created.roundId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the round.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="new-round-title">
      <h2 id="new-round-title" className="section-label">
        New Ministry registration
      </h2>
      <p className="muted small">
        Open a two-week Ministry term. POP members claim free half-hour appointments immediately;
        guests use the public booking link and provide their Player ID, name and alliance.
      </p>
      <label className="field">
        <span>Name</span>
        <input value={label} maxLength={60} placeholder="Ministry · SvS week 41" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="field">
        <span>First Monday of the two-week term</span>
        <input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
      </label>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy || label.trim().length < 3 || !weekStart}
          onClick={() => void create()}
        >
          {busy ? "Opening…" : "Open registration"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The Monday of next week, which is the usual SvS week when an officer opens a round. */
function nextMonday(from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

/** Shown to a signed-in person whose game account an officer hasn't linked yet. */
export function NoAccount() {
  return (
    <section className="card empty">
      <h2>No game account linked yet</h2>
      <p className="muted">
        An officer links your game account after checking your Player ID. You'll see your power and events here once
        that's done.
      </p>
    </section>
  );
}
