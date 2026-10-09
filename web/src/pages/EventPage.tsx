import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type Answer,
  type AttendanceStatus,
  type EventDetail,
  type EventOutcome,
  type EventListItem,
  type EventMember,
  type EventScorePhase,
  type EventScoreboard,
  type LineupEntryView,
  type PublishedLineup,
  type PublishedResult,
  type PublishedStrategy,
  type SessionView,
  STRATEGY_ROLES,
  type StrategyRole,
} from "../api";
import { ErrorBanner } from "../components/Chrome";
import { EventSignupShare } from "../components/EventSignupShare";
import { EventPersonalPerformance } from "../components/EventPersonalPerformance";
import { RegistrationRolePicker } from "../components/RegistrationRolePicker";
import { LineChart } from "../components/LineChart";
import { useToast } from "../components/Toast";
import { registrationRolePresentation } from "../eventRegistrationRole";
import { MiniChart } from "../components/MiniChart";
import { compact, dayTime, eventDayTime, eventTime, full, relativeDay, shortDate, untilText } from "../format";
import { countDraft, draftFor, entriesToPublish, type LineupDraftRow } from "../lineup";
import { navigate } from "../router";
import { levelRank } from "../rules";
import { useSession } from "../session";
import { assignmentsToPublish, StrategyText, strategyDraftFor, type StrategyDraftAssignment } from "../strategy";
import { completedAttendanceLabel, completedEventRows, type CompletedAttendance } from "../eventReport";
import { eventTimeline, type EventTimelinePoint } from "../eventTimeline";
import { visibleEventSessions } from "../eventSessions";
import { isLegionEvent } from "../eventSetup";
import { allianceScoreText, playerScoreText, rankedAllianceScores } from "../resultDisplay";
import { TROOP_LABELS, TROOP_TYPES, type TroopType } from "../troops";
import { missingMemberTroopDetails, svsTroopRequestMessage } from "../svsTroops";

const ALL_EVENT_HISTORY = "1970-01-01T00:00:00.000Z";

/** One event in full: the parts you can join, who signed up, and the officer table. */
export function EventPage({ eventId }: { eventId: string }) {
  const { api, account, isOfficer, dataVersion, dataChanged } = useSession();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [history, setHistory] = useState<EventListItem[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
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

  useEffect(() => {
    setHistoryError(false);
    api.events(ALL_EVENT_HISTORY)
      .then((result) => setHistory(result.items))
      .catch(() => setHistoryError(true));
  }, [api, dataVersion, eventId]);

  const choose = async (
    answer: Answer,
    sessionId?: string,
    registrationRole = answer === "yes" ? (event?.myRegistrationRole ?? undefined) : undefined,
    busyKey?: string,
  ) => {
    if (!account) return;
    setBusy(busyKey ?? sessionId ?? answer);
    setError(null);
    try {
      const saved = await api.answer(eventId, account.playerId, answer, sessionId, registrationRole);
      const label = sessionId ? event?.sessions.find((s) => s.id === sessionId)?.label : undefined;
      toast(label
        ? `You're in for ${label}${saved.registrationRole === "substitute" ? " as a substitute" : ""}`
        : "Signup withdrawn");
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save your answer.");
    } finally {
      setBusy(null);
    }
  };

  const publish = async (sessionId: string, rows: LineupDraftRow[], version: number) => {
    setError(null);
    try {
      const published = await api.publishLineup(eventId, sessionId, entriesToPublish(rows), version);
      toast(`Lineup published (v${published.version})`);
      dataChanged();
    } catch (e) {
      // A stale version means someone else published first; the message says to reload.
      setError(e instanceof ApiError ? e.message : "Couldn't publish the lineup.");
      throw e;
    }
  };

  const publishStrategy = async (
    sessionId: string,
    body: string,
    assignments: StrategyDraftAssignment[],
    version: number,
  ) => {
    setError(null);
    try {
      const published = await api.publishStrategy(
        eventId,
        sessionId,
        body,
        assignmentsToPublish(assignments),
        version,
      );
      toast(`Strategy published (v${published.version})`);
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't publish the strategy.");
      throw e;
    }
  };

  const recordResult = async (
    sessionId: string,
    input: Parameters<typeof api.recordResult>[2],
  ) => {
    setError(null);
    try {
      const result = await api.recordResult(eventId, sessionId, input);
      toast(`Result saved (v${result.version})`);
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the result.");
      throw e;
    }
  };

  if (error && !event) return <ErrorBanner message={error} onRetry={() => navigate("/events")} />;
  if (!event) return <div className="card skeleton" style={{ height: 200 }} />;
  const completed = Date.parse(event.startsAt) <= Date.now();
  const visibleSessions = visibleEventSessions(event, completed);
  const sessionsHaveResults = !event.scoreboards;
  const currentHistory = history?.find((item) => item.eventId === event.eventId);

  return (
    <>
      <button type="button" className="text-btn" onClick={() => navigate("/events")}>
        ‹ All events
      </button>

      <div className="page-head">
        <h1 className="page-title">{event.title}</h1>
        {!completed && isOfficer && <EventSignupShare event={event} />}
      </div>
      <p className="muted">
        {eventDayTime(event.startsAt)} ·{" "}
        {completed ? "event completed" : event.closed ? "answers closed" : `answers close ${untilText(event.deadlineAt)} (${eventDayTime(event.deadlineAt)})`}
      </p>
      {event.closed && !completed && isOfficer && (
        <p className="banner banner-warn">
          Answers are closed for members. You can still change who is coming until the event starts.
        </p>
      )}
      {event.notes && <p className="event-notes">{event.notes}</p>}

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {completed && currentHistory?.history?.mine && (
        <EventPersonalPerformance performance={currentHistory.history.mine} event={currentHistory} history={history ?? []} />
      )}

      {!completed && event.scoreboards && (
        <EventScoreboards
          eventId={event.eventId}
          scoreboards={event.scoreboards}
          {...(account ? { playerId: account.playerId } : {})}
          isOfficer={isOfficer}
          onChanged={dataChanged}
          onError={setError}
        />
      )}

      {visibleSessions.length > 0 ? (
        <ul className="stack">
          {visibleSessions.map((session) => (
            <li key={session.id}>
              <SessionCard
                session={session}
                completed={completed}
                expectsResult={sessionsHaveResults}
                closed={event.closed && !isOfficer}
                busy={busy}
                canAnswer={!completed && account !== undefined}
                isOfficer={isOfficer}
                myPlayerId={account?.playerId}
                myRegistrationRole={event.mySessionId === session.id ? event.myRegistrationRole : null}
                strategyTemplate={event.strategyTemplate ?? ""}
                onJoin={() => void choose("yes", session.id)}
                {...(isOfficer ? {
                  onPublish: publish,
                  onPublishStrategy: publishStrategy,
                  ...(sessionsHaveResults ? { onRecordResult: recordResult } : {}),
                } : {})}
              />
            </li>
          ))}
        </ul>
      ) : !completed ? (
        <p className="muted">This event has no parts to choose between.</p>
      ) : null}

      {!completed && account && isLegionEvent(event.kind) && event.myAnswer === "yes" && event.mySessionId && (
        <div className="event-signup">
          <div className="event-signup-intro">
            <strong>Your signup preference</strong>
            <span className="muted small">
              {event.sessions.find((session) => session.id === event.mySessionId)?.label} · choose whether you want a regular or substitute place.
            </span>
          </div>
          <RegistrationRolePicker
            substitute={event.myRegistrationRole === "substitute"}
            disabled={event.closed && !isOfficer}
            busy={busy === "role"}
            onChange={(substitute) => void choose(
              "yes",
              event.mySessionId ?? undefined,
              substitute ? "substitute" : undefined,
              "role",
            )}
          />
        </div>
      )}

      {completed && history && <EventProgression current={event} items={history} />}
      {completed && historyError && <p className="banner banner-error">Couldn't load the event comparison.</p>}

      {completed ? null : account && event.myAnswer === "yes" ? (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={(event.closed && !isOfficer) || busy !== null}
          onClick={() => void choose("no")}
        >
          {busy === "no" ? "…" : "Withdraw signup"}
        </button>
      ) : account ? (
        <p className="pill pill-flat">Not signed up — join either legion above</p>
      ) : null}

      {isOfficer && event.checklist && <EventChecklist event={event} />}

      {isOfficer && event.members && (completed
        ? <CompletedEventReport event={event} members={event.members} />
        : <OfficerTable event={event} members={event.members} />)}

      {completed && event.scoreboards && (
        <EventScoreboards
          eventId={event.eventId}
          scoreboards={event.scoreboards}
          completed
          {...(account ? { playerId: account.playerId } : {})}
          isOfficer={isOfficer}
          onChanged={dataChanged}
          onError={setError}
        />
      )}

      {completed && isOfficer && event.members && (
        <CompletedSignupHistory event={event} members={event.members} />
      )}
    </>
  );
}

function outcomeSummary(point: EventTimelinePoint): string {
  const parts = [
    point.wins > 0 ? `${point.wins}W` : "",
    point.losses > 0 ? `${point.losses}L` : "",
    point.draws > 0 ? `${point.draws}D` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Oldest-to-newest comparison, with the event being viewed anchored in the timeline. */
function EventProgression({ current, items }: { current: EventDetail; items: EventListItem[] }) {
  const points = eventTimeline(items, current.kind, current.eventId);
  if (points.length === 0) return null;
  const resultPoints = points.filter((point): point is EventTimelinePoint & { performance: number } => point.performance !== null);
  const preparationPoints = points.filter((point): point is EventTimelinePoint & { preparation: number } => point.preparation !== null);
  const battlePoints = points.filter((point): point is EventTimelinePoint & { battle: number } => point.battle !== null);
  const memberScope = points.some((point) => point.phaseScope === "mine");

  return (
    <section className="card event-progression" aria-labelledby="event-progression-title">
      <div className="event-progression-head">
        <div>
          <p className="section-label">Progress over time</p>
          <h2 id="event-progression-title">How this event compares</h2>
          <p className="muted small">
            Oldest to newest · the event you are viewing is highlighted
            {memberScope ? " · phase totals are your recorded scores" : ""}.
          </p>
        </div>
        <span className="pill pill-flat">{points.length} recorded event{points.length === 1 ? "" : "s"}</span>
      </div>

      {points.length === 1 && <p className="event-progression-first">This is the first recorded {current.title} result. The next one will appear here for comparison.</p>}

      <div className="event-timeline" aria-label={`${current.title} event timeline`}>
        {points.map((point, index) => {
          const previous = points[index - 1];
          const performanceChange = point.performance !== null && previous?.performance !== null && previous?.performance !== undefined
            ? point.performance - previous.performance
            : null;
          const card = (
            <>
              <div className="event-timeline-card-head">
                <span>{shortDate(point.startsAt)}</span>
                {point.current && <strong>Viewing</strong>}
              </div>
              <b>{point.title}</b>
              {point.results > 0 && (
                <>
                  <span className="event-timeline-outcome">{outcomeSummary(point)}</span>
                  {point.allianceCount !== null && point.allianceCount > 2 ? (
                    <strong>#{point.alliancePlace} of {point.allianceCount} · {full(point.ourScore ?? 0)}</strong>
                  ) : (
                    <strong>{full(point.ourScore ?? 0)} – {full(point.opponentScore ?? 0)}</strong>
                  )}
                  <small>
                    {point.performance?.toFixed(1)}% of all alliance points
                    {performanceChange !== null && ` · ${performanceChange >= 0 ? "+" : ""}${performanceChange.toFixed(1)} pts`}
                  </small>
                </>
              )}
              {(point.preparation !== null || point.battle !== null) && (
                <div className="event-timeline-phases">
                  <span><small>Preparation</small><strong>{point.preparation === null ? "–" : compact(point.preparation)}</strong></span>
                  <span><small>Battle</small><strong>{point.battle === null ? "–" : compact(point.battle)}</strong></span>
                  {point.phaseCoverage && <em>{point.phaseCoverage === "complete" ? "Complete" : "Partial data"}</em>}
                </div>
              )}
            </>
          );
          return point.current
            ? <div key={point.eventId} className="event-timeline-card current" aria-current="true">{card}</div>
            : <button key={point.eventId} type="button" className="event-timeline-card" onClick={() => navigate(`/events/${point.eventId}`)}>{card}</button>;
        })}
      </div>

      {(resultPoints.length > 1 || preparationPoints.length > 1 || battlePoints.length > 1) && (
        <div className="event-progression-charts">
          {resultPoints.length > 1 && (
            <div className="event-progression-chart">
              <span className="section-label">Team performance</span>
              <LineChart
                points={resultPoints.map((point) => ({ at: point.startsAt, value: point.performance }))}
                height={145}
                label={`${current.title} share of all alliance points over time`}
                format={(value) => `${value.toFixed(0)}%`}
                detailFormat={(value) => `${value.toFixed(1)}% of all alliance points`}
              />
            </div>
          )}
          {preparationPoints.length > 1 && (
            <div className="event-progression-chart">
              <span className="section-label">Preparation points</span>
              <LineChart points={preparationPoints.map((point) => ({ at: point.startsAt, value: point.preparation }))} height={145} label={`${current.title} preparation points over time`} />
            </div>
          )}
          {battlePoints.length > 1 && (
            <div className="event-progression-chart">
              <span className="section-label">Battle points</span>
              <LineChart points={battlePoints.map((point) => ({ at: point.startsAt, value: point.battle }))} height={145} label={`${current.title} battle points over time`} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function EventScoreboards({
  eventId,
  scoreboards,
  completed = false,
  playerId,
  isOfficer,
  onChanged,
  onError,
}: {
  eventId: string;
  scoreboards: Record<EventScorePhase, EventScoreboard>;
  completed?: boolean;
  playerId?: string;
  isOfficer: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [active, setActive] = useState<EventScorePhase>(() =>
    scoreboards.preparation.version > 0
      ? "preparation"
      : scoreboards.castle_battle.version > 0
        ? "castle_battle"
        : "preparation",
  );
  const [score, setScore] = useState("");
  const [paste, setPaste] = useState("");
  const [coverage, setCoverage] = useState<"partial" | "complete">("partial");
  const [saving, setSaving] = useState(false);
  const board = scoreboards[active];
  const mine = board.entries.find((entry) => entry.playerId === playerId);
  const compactHistory = completed && isOfficer;

  useEffect(() => setScore(mine ? String(mine.points) : ""), [active, mine?.points]);

  const saveMine = async () => {
    if (!playerId) return;
    const points = Number(score.replaceAll(/[,._\s]/g, ""));
    if (!Number.isSafeInteger(points) || points < 0) {
      onError("Enter your score as a whole number.");
      return;
    }
    setSaving(true);
    onError(null);
    try {
      await api.setEventScore(eventId, active, playerId, points);
      toast(`${active === "preparation" ? "Preparation" : "Castle battle"} score saved`);
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Couldn't save the score.");
    } finally {
      setSaving(false);
    }
  };

  const importOfficial = async () => {
    try {
      const entries = parseOfficialScorePaste(paste);
      setSaving(true);
      onError(null);
      const result = await api.importEventScores(eventId, active, {
        expectedVersion: board.version,
        coverage,
        playerPoints: entries,
        source: { type: "officer_import" },
      });
      toast(`${result.imported} official scores imported`);
      setPaste("");
      onChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't import the official scores.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card event-scoreboards" aria-labelledby="event-score-title">
      <div className="event-head">
        <div>
          <h2 id="event-score-title" className="event-title">Event scores</h2>
          <p className="muted small">Preparation and castle-battle points stay separate.</p>
        </div>
      </div>
      <div className="score-phase-tabs" role="tablist" aria-label="Score phase">
        {(["preparation", "castle_battle"] as const).map((phase) => (
          <button key={phase} type="button" role="tab" aria-selected={active === phase} className={active === phase ? "active" : ""} onClick={() => setActive(phase)}>
            {scoreboards[phase].phaseLabel}
            <span>{scoreboards[phase].entries.length}</span>
          </button>
        ))}
      </div>

      {!compactHistory && playerId && (
        <div className="my-event-score">
          <div>
            <strong>Your {board.phaseLabel.toLowerCase()} score</strong>
            <small>{mine ? "Recorded — you can correct it" : "Not in the visible top 100? Add your exact score here."}</small>
          </div>
          <input aria-label={`Your ${board.phaseLabel.toLowerCase()} score`} inputMode="numeric" placeholder="0" value={score} onChange={(event) => setScore(event.target.value)} />
          <button type="button" className="btn btn-primary btn-small" disabled={saving} onClick={() => void saveMine()}>
            {saving ? "…" : mine ? "Update" : "Add score"}
          </button>
        </div>
      )}

      {isOfficer && <div className="score-summary"><span><strong>{board.scoredPlayers}</strong> scored players</span><span><strong>{full(board.reportedPlayerSubtotal)}</strong> reported-player subtotal</span><span className="pill pill-flat">{board.coverage === "complete" ? "Complete" : "Partial data"}</span></div>}

      {compactHistory ? (
        <p className="muted small score-history-note">Individual scores and attendance evidence are shown in the completed-event report above.</p>
      ) : board.entries.length > 0 ? (
        <div className="table-wrap score-table-wrap">
          <table className="table score-table">
            <thead><tr>{isOfficer && <th>Rank</th>}<th>Member</th><th>Exact score</th></tr></thead>
            <tbody>{board.entries.map((entry) => (
              <tr key={entry.playerId} className={entry.mine ? "mine" : ""}>
                {isOfficer && <td>#{entry.rank}</td>}
                <td><strong>{entry.name}</strong><small>{entry.playerId}</small></td>
                <td>{full(entry.points)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted score-empty">No {active} scores yet.</p>}

      {isOfficer && (
        <details className="score-import">
          <summary>{compactHistory ? "Correct or import score data" : "Import player scores"}</summary>
          {compactHistory && playerId && (
            <div className="my-event-score">
              <div>
                <strong>Your {board.phaseLabel.toLowerCase()} score</strong>
                <small>{mine ? "Recorded — you can correct it" : "Not in the visible top 100? Add your exact score here."}</small>
              </div>
              <input aria-label={`Your ${board.phaseLabel.toLowerCase()} score`} inputMode="numeric" placeholder="0" value={score} onChange={(event) => setScore(event.target.value)} />
              <button type="button" className="btn btn-primary btn-small" disabled={saving} onClick={() => void saveMine()}>
                {saving ? "…" : mine ? "Update" : "Add score"}
              </button>
            </div>
          )}
          <p className="muted small">One row per player: Player ID, exact score. Omitted players remain unchanged.</p>
          <label>Data completeness<select value={coverage} onChange={(event) => setCoverage(event.target.value as "partial" | "complete")}><option value="partial">Partial — more scores may be missing</option><option value="complete">Complete — all scores confirmed</option></select></label>
          <textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder={"401234567, 987654321\n409876543, 876543210"} />
          <button type="button" className="btn btn-primary btn-small" disabled={saving || !paste.trim()} onClick={() => void importOfficial()}>Import {board.phaseLabel.toLowerCase()} scores</button>
        </details>
      )}
    </section>
  );
}

function parseOfficialScorePaste(raw: string): { playerId: string; points: number }[] {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0 || lines.length > 100) throw new Error("Paste between 1 and 100 score rows.");
  return lines.map((line, index) => {
    const parts = line.trim().split(/[\t,;]+/).map((part) => part.trim());
    if (parts.length !== 2) throw new Error(`Row ${index + 1}: use Player ID, score.`);
    const [rawPlayerId = "", rawPoints = ""] = parts;
    const playerId = rawPlayerId.replaceAll(/\s/g, "");
    const points = Number(rawPoints.replaceAll(/[._\s]/g, ""));
    if (!/^\d{6,12}$/.test(playerId) || !Number.isSafeInteger(points) || points < 0) {
      throw new Error(`Row ${index + 1}: check the Player ID and whole-number score.`);
    }
    return { playerId, points };
  });
}

function SessionCard({
  session,
  completed,
  expectsResult,
  closed,
  busy,
  canAnswer,
  isOfficer,
  myPlayerId,
  myRegistrationRole,
  onJoin,
  onPublish,
  strategyTemplate,
  onPublishStrategy,
  onRecordResult,
}: {
  session: SessionView;
  completed: boolean;
  expectsResult: boolean;
  closed: boolean;
  busy: string | null;
  canAnswer: boolean;
  isOfficer: boolean;
  myPlayerId: string | undefined;
  myRegistrationRole: "substitute" | null | undefined;
  onJoin: () => void;
  strategyTemplate: string;
  /** Officers only: publish or change the lineup for this part. */
  onPublish?: (sessionId: string, rows: LineupDraftRow[], version: number) => Promise<void>;
  /** Officers only: publish or change the plan and assignments for this part. */
  onPublishStrategy?: (
    sessionId: string,
    body: string,
    assignments: StrategyDraftAssignment[],
    version: number,
  ) => Promise<void>;
  onRecordResult?: (sessionId: string, input: Parameters<ReturnType<typeof useSession>["api"]["recordResult"]>[2]) => Promise<void>;
}) {
  const starters = session.starters;
  const subs = session.subs ?? 0;
  const capacity = starters === undefined ? null : starters + subs;
  // Before a lineup exists the meter shows who signed up; afterwards it shows the decision,
  // because "10 signed up" stops being the interesting number once officers have picked.
  const taken = session.lineup
    ? {
        starters: session.lineup.entries.filter((e) => e.role === "starter").length,
        subs: session.lineup.entries.filter((e) => e.role === "sub").length,
      }
    : null;
  const startersFilled =
    starters === undefined ? 0 : taken ? Math.min(taken.starters, starters) : Math.min(session.signedUp, starters);
  const subsFilled =
    starters === undefined
      ? 0
      : taken
        ? Math.min(taken.subs, subs)
        : Math.min(Math.max(0, session.signedUp - starters), subs);
  const startersFree = starters === undefined ? 0 : starters - startersFilled;
  const subsFree = subs - subsFilled;
  // Nobody "waits" once a lineup exists: they are either in it or they are not.
  const waiting = capacity === null || taken ? 0 : Math.max(0, session.signedUp - capacity);
  const joined = session.yourStanding !== undefined;

  return (
    <article className={`card session${joined ? " session-joined" : ""}`}>
      <div className="event-head">
        <h2 className="event-title">
          {session.label} · {eventTime(session.startsAt)}
        </h2>
        {canAnswer && (
          <button type="button" className={joined ? "btn btn-quiet btn-small" : "btn btn-primary btn-small"} disabled={closed || busy !== null} onClick={onJoin}>
            {busy === session.id ? "…" : joined ? "You're in" : "Join"}
          </button>
        )}
      </div>

      {!completed && capacity !== null ? (
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
      ) : !completed ? (
        <p className="muted small">{session.signedUp} signed up</p>
      ) : null}

      {/* Once a lineup is published it answers "am I playing?", so the estimate steps aside. */}
      {!completed && (session.lineup ? (
        session.yourPlace ? (
          <p className={session.yourPlace.role === "starter" ? "pill pill-up" : "pill pill-warn"}>
            {session.yourPlace.role === "starter"
              ? `You're starting · #${session.yourPlace.position}`
              : `You're substitute #${session.yourPlace.position}`}{" "}
            — officers published this lineup
          </p>
        ) : (
          joined && <p className="pill pill-flat">Not in this lineup — officers published it {relativeDay(session.lineup.publishedAt)}</p>
        )
      ) : (
        session.yourStanding && (myRegistrationRole === "substitute" ? (
          <p className="pill pill-warn">Registered as substitute</p>
        ) : (
          <p className={session.yourStanding.likely === "starter" ? "pill pill-up" : "pill pill-warn"}>
            {session.yourStanding.likely === "starter" ? "Likely starting" : "Likely a substitute"} · {session.yourStanding.position}
            {" of "}
            {session.yourStanding.signedUp} by Foundry strength — estimate, officers pick the lineup
          </p>
        ))
      ))}

      {completed && session.result && <ResultView result={session.result} hidePlayerPoints={isOfficer} />}
      {completed && expectsResult && !session.result && <p className="event-result-missing">No result has been recorded for this part.</p>}

      {completed ? (
        (session.lineup || session.strategy) && (
          <details className="completed-planning-record">
            <summary>Lineup &amp; strategy record</summary>
            {session.lineup && <LineupList lineup={session.lineup} myPlayerId={myPlayerId} />}
            {session.strategy && <StrategyView strategy={session.strategy} myPlayerId={myPlayerId} />}
            {session.yourAssignment && <p className="pill pill-flat">Your assignment: {session.yourAssignment.role}{session.yourAssignment.duty ? ` · ${session.yourAssignment.duty}` : ""}</p>}
          </details>
        )
      ) : (
        <>
          {session.lineup && <LineupList lineup={session.lineup} myPlayerId={myPlayerId} />}
          {session.strategy && <StrategyView strategy={session.strategy} myPlayerId={myPlayerId} />}
        </>
      )}

      {!completed && session.result && <ResultView result={session.result} />}

      {!completed && session.yourAssignment && (
        <p className="pill pill-flat">
          Your assignment: {session.yourAssignment.role}
          {session.yourAssignment.duty ? ` · ${session.yourAssignment.duty}` : ""}
        </p>
      )}

      {!completed && session.signedUpList.length > 0 && (
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
                  <th scope="col">Role</th>
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
                      {(() => {
                        const role = registrationRolePresentation(entry);
                        return <span className={`pill pill-${role.tone}`}>{role.label}</span>;
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            {session.lineup
              ? "This is the ranking the lineup above was built from."
              : isOfficer
                ? "Ranked by Foundry strength (70%) and attendance (30%) — an estimate until officers publish the lineup."
                : "Ranked by Foundry strength and reliability — an estimate until officers publish the lineup."}
          </p>
        </details>
      )}

      {completed && isOfficer ? (
        <details className="completed-event-tools">
          <summary>Officer corrections</summary>
          <p className="muted small">Historical signup, lineup, strategy and result corrections.</p>
          {onPublish && <LineupEditor session={session} onPublish={onPublish} />}
          {onPublishStrategy && <StrategyEditor session={session} template={strategyTemplate} onPublish={onPublishStrategy} />}
          {onRecordResult && <ResultEditor session={session} onSave={onRecordResult} />}
        </details>
      ) : (
        <>
          {isOfficer && onPublish && <LineupEditor session={session} onPublish={onPublish} />}
          {isOfficer && onPublishStrategy && <StrategyEditor session={session} template={strategyTemplate} onPublish={onPublishStrategy} />}
          {isOfficer && onRecordResult && Date.parse(session.startsAt) <= Date.now() && <ResultEditor session={session} onSave={onRecordResult} />}
        </>
      )}
    </article>
  );
}

function ResultView({ result, hidePlayerPoints = false }: { result: PublishedResult; hidePlayerPoints?: boolean }) {
  const outcome = result.outcome === "win" ? "Victory" : result.outcome === "loss" ? "Defeat" : "Draw";
  const winner = result.allianceScores ? rankedAllianceScores(result.allianceScores)[0] : undefined;
  return (
    <section className="strategy stack" aria-label="Event result">
      <h3 className="section-label">
        Result · {outcome} <span className="muted small">· recorded {relativeDay(result.recordedAt)}</span>
      </h3>
      {result.allianceScores ? (
        <div className="alliance-result-grid" aria-label="Alliance battle totals">
          {rankedAllianceScores(result.allianceScores).map((row, index) => (
            <article key={row.allianceTag} className={`alliance-result-card${row.isOurAlliance ? " is-ours" : ""}${index === 0 ? " is-winner" : ""}`}>
              <span className="muted small">{index === 0 ? "Winner" : `#${index + 1}`}</span>
              <strong>[{row.allianceTag}] {row.allianceName}</strong>
              <b title={row.precision.kind === "rounded" ? `Rounded to the nearest ${full(row.precision.roundedTo)} points` : "Exact battle score"}>{allianceScoreText(row)}</b>
              {row.precision.kind === "rounded" && <small>rounded display</small>}
            </article>
          ))}
          <p className="muted small alliance-result-note">Alliance totals are official battle scores, not a sum of player scores. Winner: [{winner?.allianceTag}] {winner?.allianceName}.</p>
        </div>
      ) : (
        <p className="pill pill-flat">Score: {full(result.ourScore)} – {full(result.opponentScore)}</p>
      )}
      {(result.ourMatchmakingPower !== undefined || result.opponentMatchmakingPower !== undefined) && (
        <p className="muted small">
          Matchmaking power: {result.ourMatchmakingPower === undefined ? "–" : compact(result.ourMatchmakingPower)} vs{" "}
          {result.opponentMatchmakingPower === undefined ? "–" : compact(result.opponentMatchmakingPower)}
          {result.opponentCombatants !== undefined ? ` · ${result.opponentCombatants} opponents` : ""}
        </p>
      )}
      {result.notes && <p className="event-notes">{result.notes}</p>}
      {hidePlayerPoints && result.playerPoints.length > 0 && (
        <p className="muted small">{result.playerPoints.length} individual score{result.playerPoints.length === 1 ? "" : "s"} recorded · shown in the attendance report below</p>
      )}
      {!hidePlayerPoints && result.playerPoints.length > 0 && (
        <div className="pop-player-results">
          <h4>POP player results</h4>
          {result.playerPoints.toSorted((a, b) => b.points - a.points).map((row) => (
            <p key={row.playerId} className="pop-player-result">
              <span><strong>{row.name}</strong>{row.role ? <small>{row.role === "starter" ? "Starter" : "Substitute"}</small> : null}</span>
              <span className={`pill ${row.points > 0 ? "pill-up" : "pill-down"}`}>{row.points > 0 ? "Attended" : "Registered no-show"}</span>
              <b title={row.precision?.kind === "rounded" ? `Rounded to the nearest ${full(row.precision.roundedTo)} points` : "Exact player score"}>{playerScoreText(row)} pts</b>
            </p>
          ))}
          <p className="muted small">Players without a score remain unknown. Opponent player data is not available.</p>
        </div>
      )}
    </section>
  );
}

function ResultEditor({
  session,
  onSave,
}: {
  session: SessionView;
  onSave: (sessionId: string, input: Parameters<ReturnType<typeof useSession>["api"]["recordResult"]>[2]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = session.result;
  const [outcome, setOutcome] = useState<EventOutcome>("win");
  const [ourScore, setOurScore] = useState("");
  const [opponentScore, setOpponentScore] = useState("");
  const [ourPower, setOurPower] = useState("");
  const [opponentPower, setOpponentPower] = useState("");
  const [opponents, setOpponents] = useState("");
  const [notes, setNotes] = useState("");
  const [points, setPoints] = useState<Record<string, string>>({});
  const start = () => {
    setOutcome(current?.outcome ?? "win");
    setOurScore(current ? String(current.ourScore) : "");
    setOpponentScore(current ? String(current.opponentScore) : "");
    setOurPower(current?.ourMatchmakingPower === undefined ? "" : String(current.ourMatchmakingPower));
    setOpponentPower(current?.opponentMatchmakingPower === undefined ? "" : String(current.opponentMatchmakingPower));
    setOpponents(current?.opponentCombatants === undefined ? "" : String(current.opponentCombatants));
    setNotes(current?.notes ?? "");
    setPoints(Object.fromEntries((current?.playerPoints ?? []).map((row) => [row.playerId, String(row.points)])));
    setOpen(true);
  };
  if (!open) return <button type="button" className="btn btn-quiet btn-small" onClick={start}>{current ? `Edit result (v${current.version})` : "Record result"}</button>;
  const players = session.lineup?.entries ?? session.signedUpList;
  return (
    <div className="strategy-editor stack">
      <div className="form-grid">
        <label className="field"><span>Outcome</span><select value={outcome} onChange={(e) => setOutcome(e.target.value as EventOutcome)}><option value="win">Victory</option><option value="loss">Defeat</option><option value="draw">Draw</option></select></label>
        <label className="field"><span>Our score</span><input type="number" min="0" required value={ourScore} onChange={(e) => setOurScore(e.target.value)} /></label>
        <label className="field"><span>Opponent score</span><input type="number" min="0" required value={opponentScore} onChange={(e) => setOpponentScore(e.target.value)} /></label>
        <label className="field"><span>Our matchmaking power</span><input type="number" min="0" value={ourPower} onChange={(e) => setOurPower(e.target.value)} /></label>
        <label className="field"><span>Opponent matchmaking power</span><input type="number" min="0" value={opponentPower} onChange={(e) => setOpponentPower(e.target.value)} /></label>
        <label className="field"><span>Opponent combatants</span><input type="number" min="0" max="100" value={opponents} onChange={(e) => setOpponents(e.target.value)} /></label>
      </div>
      <label className="field"><span>Notes</span><textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {players.length > 0 && <div className="strategy-assignment-editor">{players.map((player) => <label key={player.playerId} className="field"><span>{player.name} points</span><input type="number" min="0" value={points[player.playerId] ?? ""} onChange={(e) => setPoints((old) => ({ ...old, [player.playerId]: e.target.value }))} /></label>)}</div>}
      <div className="row-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={saving || ourScore === "" || opponentScore === ""} onClick={() => {
          setSaving(true);
          void onSave(session.id, {
            outcome, ourScore: Number(ourScore), opponentScore: Number(opponentScore),
            ...(ourPower === "" ? {} : { ourMatchmakingPower: Number(ourPower) }),
            ...(opponentPower === "" ? {} : { opponentMatchmakingPower: Number(opponentPower) }),
            ...(opponents === "" ? {} : { opponentCombatants: Number(opponents) }),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            playerPoints: Object.entries(points).filter(([, value]) => value !== "").map(([playerId, value]) => {
              const role = current?.playerPoints.find((row) => row.playerId === playerId)?.role;
              const precision = current?.playerPoints.find((row) => row.playerId === playerId)?.precision;
              return { playerId, points: Number(value), ...(role ? { role } : {}), ...(precision ? { precision } : {}) };
            }),
            expectedVersion: current?.version ?? 0,
          }).then(() => setOpen(false)).finally(() => setSaving(false));
        }}>{saving ? "Saving…" : "Save result"}</button>
        <button type="button" className="btn btn-quiet btn-small" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

/** The published plan and roles as every member sees them. */
function StrategyView({ strategy, myPlayerId }: { strategy: PublishedStrategy; myPlayerId: string | undefined }) {
  return (
    <section className="strategy" aria-label="Published strategy">
      <h3 className="section-label">
        Strategy <span className="muted small">· published {relativeDay(strategy.publishedAt)}</span>
      </h3>
      {strategy.body && (
        <div className="strategy-body">
          <StrategyText text={strategy.body} />
        </div>
      )}
      {strategy.assignments.length > 0 && (
        <div className="table-wrap">
          <table className="table strategy-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Duty</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {strategy.assignments.map((assignment) => (
                <tr key={assignment.playerId} className={assignment.playerId === myPlayerId ? "row-me" : undefined}>
                  <th scope="row">{assignment.name}</th>
                  <td>{assignment.role}</td>
                  <td>{assignment.duty ?? "–"}</td>
                  <td>{assignment.note ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StrategyEditor({
  session,
  template,
  onPublish,
}: {
  session: SessionView;
  template: string;
  onPublish: (sessionId: string, body: string, assignments: StrategyDraftAssignment[], version: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [rows, setRows] = useState<StrategyDraftAssignment[]>([]);
  const [saving, setSaving] = useState(false);

  const start = () => {
    setBody(session.strategy?.body ?? template);
    setRows(strategyDraftFor(session));
    setOpen(true);
  };
  const change = (playerId: string, patch: Partial<Pick<StrategyDraftAssignment, "role" | "duty" | "note">>) =>
    setRows((current) => current.map((row) => (row.playerId === playerId ? { ...row, ...patch } : row)));

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-small" onClick={start}>
        {session.strategy ? `Edit strategy (v${session.strategy.version})` : "Publish strategy"}
      </button>
    );
  }

  return (
    <div className="strategy-editor stack">
      <label className="field">
        <span>Plan</span>
        <textarea
          rows={10}
          maxLength={20_000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Use blank lines, - bullets and **bold** text."
        />
      </label>
      {rows.length === 0 ? (
        <p className="muted small">Publish a lineup first to add member assignments. You can still publish the plan.</p>
      ) : (
        <div className="strategy-assignment-editor">
          {rows.map((row) => (
            <fieldset key={row.playerId} className="strategy-assignment">
              <legend>{row.name}</legend>
              <label>
                <span>Role</span>
                <select
                  aria-label={`${row.name}'s strategy role in ${session.label}`}
                  value={row.role}
                  onChange={(event) => change(row.playerId, { role: event.target.value as StrategyRole | "" })}
                >
                  <option value="">Unassigned</option>
                  {STRATEGY_ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Duty</span>
                <input value={row.duty} maxLength={200} onChange={(event) => change(row.playerId, { duty: event.target.value })} />
              </label>
              <label>
                <span>Note</span>
                <input value={row.note} maxLength={500} onChange={(event) => change(row.playerId, { note: event.target.value })} />
              </label>
            </fieldset>
          ))}
        </div>
      )}
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onPublish(session.id, body, rows, session.strategy?.version ?? 0)
              .then(() => setOpen(false))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Publishing…" : session.strategy ? "Publish changes" : "Publish strategy"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The published lineup as everyone sees it: starters, then substitutes, own row highlighted. */
function LineupList({ lineup, myPlayerId }: { lineup: PublishedLineup; myPlayerId: string | undefined }) {
  const starters = lineup.entries.filter((e) => e.role === "starter");
  const subs = lineup.entries.filter((e) => e.role === "sub");
  const row = (entry: LineupEntryView) => (
    <li key={entry.playerId} className={entry.playerId === myPlayerId ? "lineup-row row-me" : "lineup-row"}>
      <span className="num muted">{entry.position}</span>
      <span>
        {entry.name}
        {!entry.signedUp && <span className="muted small"> · didn't answer</span>}
      </span>
      <span className="num muted">{entry.foundryStrength === null ? "–" : full(entry.foundryStrength)}</span>
    </li>
  );

  return (
    <section className="lineup" aria-label="Published lineup">
      <h3 className="section-label">
        Lineup <span className="muted small">· published {relativeDay(lineup.publishedAt)}</span>
      </h3>
      {lineup.note && <p className="event-notes">{lineup.note}</p>}
      <p className="muted small">Starting ({starters.length})</p>
      <ul className="lineup-list">{starters.map(row)}</ul>
      {subs.length > 0 && (
        <>
          <p className="muted small">Substitutes ({subs.length})</p>
          <ul className="lineup-list">{subs.map(row)}</ul>
        </>
      )}
    </section>
  );
}

/**
 * Officers turn the estimate into a decision (P5.4). The list opens on the published lineup, or
 * on the estimate when nothing is published yet, so the usual job is to check and publish.
 */
function LineupEditor({
  session,
  onPublish,
}: {
  session: SessionView;
  onPublish: (sessionId: string, rows: LineupDraftRow[], version: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LineupDraftRow[]>([]);
  const [saving, setSaving] = useState(false);

  const start = () => {
    setRows(draftFor(session));
    setOpen(true);
  };
  const counts = countDraft(rows, session);
  const setRole = (playerId: string, role: LineupDraftRow["role"]) =>
    setRows((current) => current.map((r) => (r.playerId === playerId ? { ...r, role } : r)));

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-small" onClick={start}>
        {session.lineup ? `Edit lineup (v${session.lineup.version})` : "Publish lineup"}
      </button>
    );
  }

  return (
    <div className="lineup-editor stack">
      <p className="muted small">
        Starting {counts.starters}
        {session.starters !== undefined && ` of ${session.starters}`} · Substitutes {counts.subs}
        {session.subs !== undefined && ` of ${session.subs}`}
        {counts.overCapacity && <span className="pill pill-warn"> too many</span>}
      </p>
      <ul className="lineup-list">
        {rows.map((r) => (
          <li key={r.playerId} className="lineup-row">
            <span>
              {r.name}
              {!r.signedUp && <span className="muted small"> · didn't answer</span>}
            </span>
            <span className="num muted">{r.foundryStrength === null ? "–" : full(r.foundryStrength)}</span>
            <select
              aria-label={`${r.name}'s place in ${session.label}`}
              value={r.role}
              onChange={(e) => setRole(r.playerId, e.target.value as LineupDraftRow["role"])}
            >
              <option value="starter">Starting</option>
              <option value="sub">Substitute</option>
              <option value="out">Not playing</option>
            </select>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={saving || counts.overCapacity}
          onClick={() => {
            setSaving(true);
            void onPublish(session.id, rows, session.lineup?.version ?? 0)
              .then(() => setOpen(false))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Publishing…" : session.lineup ? "Publish changes" : "Publish lineup"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The jobs for running this event, and who runs it. Any officer can tick one off — the job still
 * has to get done when the owner is asleep — and the tick records who did it.
 */
function EventChecklist({ event }: { event: EventDetail }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const tasks = event.checklist?.tasks ?? [];
  const left = tasks.filter((t) => t.state !== "done").length;

  const tick = async (taskId: string, done: boolean) => {
    setBusy(taskId);
    try {
      await api.tickJob(event.eventId, taskId, done);
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that");
    } finally {
      setBusy(null);
    }
  };

  const setOwner = async (playerId: string) => {
    try {
      await api.updateEvent(event.eventId, { ownerPlayerId: playerId });
      toast(playerId ? "Owner set" : "Handed back to nobody");
      dataChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't change the owner");
    }
  };

  const officers = (event.members ?? []).filter((m) => m.rank === "R4" || m.rank === "R5");

  return (
    <section className="card stack" aria-labelledby="checklist-title">
      <div>
        <h2 id="checklist-title" className="section-label">
          Running this event
        </h2>
        <p className="muted small">
          {left === 0 ? "Everything is done." : `${left} still to do.`} Anyone can tick a job off.
        </p>
      </div>

      <label className="field">
        <span>Who runs it</span>
        <select value={event.ownerPlayerId ?? ""} onChange={(e) => void setOwner(e.target.value)}>
          <option value="">Nobody yet</option>
          {officers.map((m) => (
            <option key={m.playerId} value={m.playerId}>
              {m.name}
              {m.rank ? ` · ${m.rank}` : ""}
            </option>
          ))}
        </select>
      </label>

      <ul className="jobs">
        {tasks.map((task) => (
          <li key={task.id} className="job-row">
            <button
              type="button"
              className={task.state === "done" ? "job-tick job-done" : "job-tick"}
              aria-label={`${task.state === "done" ? "Undo" : "Done"}: ${task.label}`}
              aria-pressed={task.state === "done"}
              disabled={busy !== null}
              onClick={() => void tick(task.id, task.state !== "done")}
            >
              {busy === task.id ? "…" : task.state === "done" ? "✓" : "○"}
            </button>
            <span className="job-text">
              <strong className={task.state === "done" ? "job-struck" : undefined}>{task.label}</strong>
              <span className="muted">
                {task.state === "done" ? (
                  `done ${relativeDay(task.doneAt!)}`
                ) : task.state === "overdue" ? (
                  <span className="delta-down">missed · was due {dayTime(task.dueAt)}</span>
                ) : (
                  `${task.state === "due" ? "due" : "from"} ${dayTime(task.dueAt)}`
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type CompletedReportFilter = "records" | "all" | CompletedAttendance;

/** Completed events lead with evidence and results, not the pre-event planning controls. */
function CompletedEventReport({ event, members }: { event: EventDetail; members: EventMember[] }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<CompletedReportFilter>("records");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const rows = useMemo(() => completedEventRows({ ...event, members }), [event, members]);
  const counts = rows.reduce<Record<CompletedAttendance, number>>((result, row) => {
    result[row.attendance] += 1;
    return result;
  }, { present: 0, absent: 0, excused: 0, unrecorded: 0 });
  const recordCount = rows.filter((row) => row.hasEventRecord).length;
  const signedUp = rows.filter((row) => row.member.answer === "yes");
  const signedUpAttended = signedUp.filter((row) => row.attendance === "present").length;
  const noShows = signedUp.filter((row) => row.attendance === "absent").length;
  const walkIns = rows.filter((row) => row.member.answer !== "yes" && row.attendance === "present").length;
  const hasPhaseScores = Boolean(event.scoreboards);
  const phaseSummaries = event.scoreboards
    ? (["preparation", "castle_battle"] as const).map((phase) => event.scoreboards![phase])
    : [];
  const visible = rows.filter((row) => {
    if (filter === "records" && !row.hasEventRecord) return false;
    if (filter !== "records" && filter !== "all" && row.attendance !== filter) return false;
    const normalized = query.trim().toLowerCase();
    return !normalized || row.member.name.toLowerCase().includes(normalized) || row.member.playerId.includes(normalized);
  });

  const mark = async (member: EventMember, status: AttendanceStatus) => {
    setSaving(member.playerId);
    try {
      await api.attendance(event.eventId, member.playerId, status, member.sessionId ?? undefined);
      toast(`${member.name}: ${status === "present" ? "attended" : status === "absent" ? "did not attend" : status}`);
      setCorrecting(null);
      dataChanged();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Couldn't save attendance");
    } finally {
      setSaving(null);
    }
  };

  const statusClass = (status: CompletedAttendance) => status === "present"
    ? "pill-up"
    : status === "absent"
      ? "pill-down"
      : status === "excused"
        ? "pill-warn"
        : "pill-flat";

  return (
    <section className="card completed-event-report" aria-labelledby="completed-report-title">
      <div className="completed-report-head">
        <div>
          <p className="section-label">Completed event</p>
          <h2 id="completed-report-title">Attendance &amp; individual scores</h2>
          <p className="muted small">
            Recorded scores and approved R4 bot result rows count as attendance evidence. {event.kind === "foundry" || event.kind === "canyon"
              ? "A complete officer review can identify everyone who attended; until that review is imported, missing evidence stays “Not reviewed”."
              : event.kind === "svs" || event.kind === "koi" || event.kind === "fdt"
                ? "The statewide Top 100 is partial: listed POP players count as attended, while unlisted members stay “Not reviewed”."
                : "Missing evidence stays “Not reviewed”—it is never silently changed to absent."}
          </p>
        </div>
        <span className="pill pill-flat">{recordCount} event records</span>
      </div>

      {phaseSummaries.length > 0 && (
        <div className="completed-score-summaries" aria-label="Event score overview">
          {phaseSummaries.map((board) => (
            <div key={board.phaseLabel}>
              <span>{board.phaseLabel}</span>
              <strong>{board.scoredPlayers} scored</strong>
              <small>{full(board.reportedPlayerSubtotal)} reported points · {board.coverage === "complete" ? "complete" : "partial data"}</small>
            </div>
          ))}
        </div>
      )}

      <section className="completed-event-health" aria-labelledby="completed-event-health-title">
        <div>
          <span className="section-label">Event health</span>
          <strong id="completed-event-health-title">Signup compared with evidence</strong>
        </div>
        <div className="completed-event-health-grid">
          <span><strong>{counts.present}</strong><small>Confirmed attended</small></span>
          <span><strong>{signedUpAttended} / {signedUp.length}</strong><small>Signups confirmed</small></span>
          <span><strong>{noShows}</strong><small>Signed up, did not attend</small></span>
          <span><strong>{walkIns}</strong><small>Attended without signup</small></span>
          <span><strong>{counts.unrecorded}</strong><small>Still not reviewed</small></span>
        </div>
        <small>Only explicit attendance or score evidence is used. Unknown records are not treated as absences.</small>
      </section>

      <div className="completed-report-filters" role="group" aria-label="Filter completed event report">
        <button type="button" className={filter === "records" ? "active" : ""} onClick={() => setFilter("records")}><strong>{recordCount}</strong><span>Event records</span></button>
        <button type="button" className={filter === "present" ? "active" : ""} onClick={() => setFilter("present")}><strong>{counts.present}</strong><span>Attended</span></button>
        <button type="button" className={filter === "absent" ? "active" : ""} onClick={() => setFilter("absent")}><strong>{counts.absent}</strong><span>Did not attend</span></button>
        <button type="button" className={filter === "excused" ? "active" : ""} onClick={() => setFilter("excused")}><strong>{counts.excused}</strong><span>Excused</span></button>
        <button type="button" className={filter === "unrecorded" ? "active" : ""} onClick={() => setFilter("unrecorded")}><strong>{counts.unrecorded}</strong><span>Not reviewed</span></button>
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><strong>{rows.length}</strong><span>All members</span></button>
      </div>

      <input className="search" type="search" placeholder="Search member or Player ID" aria-label="Search completed event report" value={query} onChange={(change) => setQuery(change.target.value)} />

      <div className="table-wrap completed-report-table-wrap">
        <table className="table completed-report-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Attendance</th>
              {hasPhaseScores ? <><th scope="col" className="num">Preparation</th><th scope="col" className="num">Battle</th></> : <th scope="col" className="num">Player score</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.member.playerId}>
                <td><strong>{row.member.name}</strong>{row.member.rank && <span className="muted small"> · {row.member.rank}</span>}<small>{row.member.playerId}</small></td>
                <td>
                  <div className="completed-attendance-cell">
                    <span className={`pill ${statusClass(row.attendance)}`}>{completedAttendanceLabel(row.attendance)}</span>
                    {row.attendanceEvidence === "score" && <small>Score evidence</small>}
                    {correcting === row.member.playerId ? <div className="completed-attendance-editor">
                      <select autoFocus aria-label={`Attendance for ${row.member.name}`} disabled={saving === row.member.playerId} value={row.attendance === "unrecorded" ? "unknown" : row.attendance} onChange={(change) => void mark(row.member, change.target.value as AttendanceStatus)}>
                        <option value="unknown">Not reviewed</option>
                        <option value="present">Attended</option>
                        <option value="absent">Did not attend</option>
                        <option value="excused">Excused</option>
                      </select>
                      <button type="button" className="text-btn small" onClick={() => setCorrecting(null)}>Cancel</button>
                    </div> : <button type="button" className="text-btn small completed-attendance-correct" onClick={() => setCorrecting(row.member.playerId)}>Correct</button>}
                  </div>
                </td>
                {hasPhaseScores ? (
                  <>
                    <td className="num completed-score-data" data-label="Preparation score">{row.preparationPoints === null ? "–" : full(row.preparationPoints)}</td>
                    <td className="num completed-score-data" data-label="Battle score">{row.castleBattlePoints === null ? "–" : full(row.castleBattlePoints)}</td>
                  </>
                ) : (
                  <td className="num completed-score-cell completed-score-data" data-label="Player score">
                    {row.sessionScores.length === 0 ? "–" : row.sessionScores.map((score) => (
                      <span key={score.sessionId}><small>{score.label}</small><strong>{playerScoreText(score)}</strong></span>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="muted center table-empty">No members match this view.</p>}
      </div>
    </section>
  );
}

/** Signup choices helped with planning, but after the event the evidence and scores matter more. */
function CompletedSignupHistory({ event, members }: { event: EventDetail; members: EventMember[] }) {
  const rows = completedEventRows({ ...event, members }).filter((row) =>
    row.member.answer !== null || row.member.lineup !== null,
  );
  if (rows.length === 0) return null;

  return (
    <section className="card completed-signup-history" aria-labelledby="completed-signup-title">
      <details>
        <summary id="completed-signup-title">
          Signup &amp; lineup history <span className="pill pill-flat">{rows.length}</span>
        </summary>
        <p className="muted small">
          Planning record only. Recorded scores and officer attendance decisions determine who attended.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Signup</th>
                <th scope="col">Published lineup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.member.playerId}>
                  <td><strong>{row.member.name}</strong><small>{row.member.playerId}</small></td>
                  <td>{row.answerLabel}</td>
                  <td>{row.lineupLabel ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/** Officer view: every member with the numbers needed to balance upcoming legions (EVT-04). */
function OfficerTable({ event, members }: { event: EventDetail; members: EventMember[] }) {
  const { api, dataChanged } = useSession();
  const toast = useToast();
  const started = Date.parse(event.startsAt) <= Date.now();
  const [saving, setSaving] = useState<string | null>(null);
  const [view, setView] = useState<"planning" | "troops">("planning");

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
      ? `${event.sessions.find((s) => s.id === m.sessionId)?.label ?? "Yes"}${m.registrationRole === "substitute" ? " · Substitute" : ""}`
        : m.answer === "no"
          ? "Not signed up"
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
      <div className="officer-event-view-head">
        <h2 id="who-title" className="section-label">Who's coming</h2>
        {event.kind === "svs" && <div className="segmented officer-event-tabs" role="radiogroup" aria-label="Officer SvS view">
          <button type="button" role="radio" aria-checked={view === "planning"} onClick={() => setView("planning")}>Signup overview</button>
          <button type="button" role="radio" aria-checked={view === "troops"} onClick={() => setView("troops")}>Troop strength</button>
        </div>}
      </div>

      {view === "troops" && event.kind === "svs" ? <SvsTroopIntel event={event} members={members} /> : <>
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
              <th scope="col">Lineup</th>
              <th scope="col" className="num">
                Foundry
              </th>
              <th scope="col" title="Foundry strength at the end of each of the last six months">
                Strength 6m
              </th>
              <th scope="col" title="Attendance, averaged over each month and the two before it">
                Attendance 6m
              </th>
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
                <td>
                  {m.lineup ? (
                    <span className={m.lineup.role === "starter" ? "pill pill-up" : "pill pill-warn"}>
                      {event.sessions.find((s) => s.id === m.lineup!.sessionId)?.label ?? m.lineup.sessionId}
                      {m.lineup.role === "starter" ? " · start " : " · sub "}
                      {m.lineup.position}
                    </span>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="num">{m.foundryStrength === null ? "–" : full(m.foundryStrength)}</td>
                <td>
                  <MiniChart values={m.strengthTrend} label={`${m.name}: Foundry strength over six months`} />
                </td>
                <td>
                  <MiniChart
                    values={m.attendanceTrend}
                    domain={[0, 1]}
                    midline
                    label={`${m.name}: attendance, three-month trailing average over the last six months`}
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
      </>}
    </section>
  );
}

function SvsTroopIntel({ event, members }: { event: EventDetail; members: EventMember[] }) {
  const toast = useToast();
  const [signedUpOnly, setSignedUpOnly] = useState(true);
  const signedUp = members.filter((member) => member.answer === "yes");
  const complete = signedUp.filter((member) => missingMemberTroopDetails(member).length === 0);
  const heliosCounts = Object.fromEntries(TROOP_TYPES.map((type) => [
    type,
    signedUp.filter((member) => member.troops?.[type]?.helios === true).length,
  ])) as Record<TroopType, number>;
  const visible = (signedUpOnly ? signedUp : members).toSorted((a, b) =>
    Number(b.answer === "yes") - Number(a.answer === "yes")
    || TROOP_TYPES.filter((type) => b.troops?.[type]?.helios === true).length - TROOP_TYPES.filter((type) => a.troops?.[type]?.helios === true).length
    || (levelRank(String(b.furnace ?? "")) ?? -1) - (levelRank(String(a.furnace ?? "")) ?? -1)
    || a.name.localeCompare(b.name));
  const answerLabel = (member: EventMember) => member.answer === "yes"
    ? event.sessions.find((session) => session.id === member.sessionId)?.label ?? "Joining"
    : member.answer === "no" ? "Not attending" : member.answer === "maybe" ? "Maybe" : "No answer";

  const copyRequest = async () => {
    const message = svsTroopRequestMessage(`${window.location.origin}/power?update=1`);
    try {
      await navigator.clipboard.writeText(message);
      toast("Troop update request copied");
    } catch {
      toast("Couldn't copy the request");
    }
  };

  const troopCell = (member: EventMember, type: TroopType) => {
    const troop = member.troops?.[type];
    return <span className="svs-troop-cell">
      <strong>{troop?.level ?? "–"}</strong>
      {troop?.helios === true
        ? <span className="pill pill-up">Helios</span>
        : troop?.helios === false
          ? <small>No Helios</small>
          : <small className="delta-down">Helios unknown</small>}
    </span>;
  };

  return <div className="svs-troop-intel">
    <div className="svs-troop-intro">
      <div>
        <strong>SvS troop readiness</strong>
        <span className="muted small">Reported furnace, troop FC levels and Helios status for planning rallies and reinforcements.</span>
      </div>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => void copyRequest()}>Copy update request</button>
    </div>

    <div className="svs-troop-summary" aria-label="SvS troop data summary">
      <span><strong>{complete.length} / {signedUp.length}</strong><small>Signups complete</small></span>
      {TROOP_TYPES.map((type) => <span key={type}><strong>{heliosCounts[type]}</strong><small>{TROOP_LABELS[type]} Helios</small></span>)}
      <span><strong>{signedUp.length - complete.length}</strong><small>Need an update</small></span>
    </div>

    <div className="segmented svs-troop-filter" role="radiogroup" aria-label="SvS troop roster filter">
      <button type="button" role="radio" aria-checked={signedUpOnly} onClick={() => setSignedUpOnly(true)}>Signed up ({signedUp.length})</button>
      <button type="button" role="radio" aria-checked={!signedUpOnly} onClick={() => setSignedUpOnly(false)}>All members ({members.length})</button>
    </div>

    <div className="table-wrap">
      <table className="table svs-troop-table">
        <thead><tr>
          <th scope="col">Member</th>
          <th scope="col">Signup</th>
          <th scope="col">Furnace</th>
          {TROOP_TYPES.map((type) => <th key={type} scope="col">{TROOP_LABELS[type]}</th>)}
          <th scope="col">Data</th>
        </tr></thead>
        <tbody>{visible.map((member) => {
          const missing = missingMemberTroopDetails(member);
          return <tr key={member.playerId}>
            <td data-label="Member"><strong>{member.name}</strong>{member.rank && <small>{member.rank}</small>}</td>
            <td data-label="Signup">{answerLabel(member)}</td>
            <td data-label="Furnace"><strong>{member.furnace ?? "–"}</strong></td>
            {TROOP_TYPES.map((type) => <td key={type} data-label={TROOP_LABELS[type]}>{troopCell(member, type)}</td>)}
            <td data-label="Data status">{missing.length === 0
              ? <><span className="pill pill-up">Complete</span>{member.troopReportAt && <small>{relativeDay(member.troopReportAt)}</small>}</>
              : <><span className="pill pill-warn">Missing {missing.length}</span><small>{missing.join(", ")}</small></>}</td>
          </tr>;
        })}</tbody>
      </table>
      {visible.length === 0 && <p className="muted center table-empty">Nobody is signed up yet.</p>}
    </div>
  </div>;
}
