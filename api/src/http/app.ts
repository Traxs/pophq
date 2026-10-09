import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { parseAccountChanges, parseNewAccount, type GameAccount } from "../domain/accounts.js";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../domain/errors.js";
import { parseAttendance } from "../domain/attendance.js";
import { eventOccurrenceKey, participationOf } from "../domain/participation.js";
import {
  EVENT_KINDS,
  configureLegacySession,
  countAnswers,
  isClosed,
  parseAgentEventChanges,
  parseAgentEventRegistrations,
  parseAgentNewEvent,
  parseAnswerChoice,
  parseEventChanges,
  parseNewEvent,
  rankSignUps,
  standingFor,
  type AllianceEvent,
  type EventAnswer,
  type EventKind,
} from "../domain/events.js";
import { parseEventType, STARTER_TYPES } from "../domain/eventTypes.js";
import { applyTick, datedTasks, STARTER_CHECKLISTS } from "../domain/checklists.js";
import { parseLineup, placeIn } from "../domain/lineups.js";
import { KUDOS_DECAY_DAYS, kudosContribution, kudosScore, kudosShare, parseKudos } from "../domain/kudos.js";
import { FORTRESS_BUFFS, parseFortressBuffPool, parseFortressBuffPools, type FortressBuff, type FortressBuffPool } from "../domain/fortressBuffs.js";
import {
  dayEndsAt,
  parseNewRound,
  parsePreferences,
  roundState,
  slotStartsAt,
  SLOTS_PER_DAY,
  BUFF_ATTENDANCE_WEIGHT,
  BUFF_KUDOS_WEIGHT,
  BUFF_STRENGTH_WEIGHT,
  buffScore,
  ministryGuestTokenHash,
  ministryTerm,
  newGuestSecret,
  parseGuestBooking,
  parseMinistryProtections,
  parseSlotClaim,
  validateClaim,
  type MinistryBooking,
  type SvsRound,
} from "../domain/svs.js";
import { parseStrategy } from "../domain/strategy.js";
import { parseEventResult, type EventResult } from "../domain/results.js";
import { parsePhaseScoreUpsert, parseSelfScore, phaseScoreCounts, phasesForEvent, scorePhaseFor, scoreSubtotal, upsertPhaseScores } from "../domain/eventScores.js";
import { canonicalJson, issueAgentToken } from "../domain/agentTokens.js";
import { HISTORICAL_CATEGORIES, parseHistoricalRecord, type HistoricalCategory } from "../domain/historicalRecords.js";
import { authenticateAgent, effectiveBotScopes, publicAgentToken, type BotIssuerGroups } from "./agentAuth.js";
import { listEventTypes } from "../ops/eventTypes.js";
import { membershipChanges, membershipPeriods, parseGameName, parseIdentityJustification, parseMembershipEffectiveDate, parsePlayerId, wasMemberAt, type IdentityAuditRecord, type MembershipPeriod } from "../domain/identity.js";
import { allianceAttendance, allianceGrowth, buckets, currentOf, seriesOf } from "../domain/metrics.js";
import { monthlyAttendance, monthlyValues, trailingAverage } from "../domain/trends.js";
import { activeReports, currentValues, parseImportedReport, parseReport } from "../domain/measurements.js";
import {
  defaultActing,
  effectiveGroups,
  grantsOfficerAccess,
  isOfficer,
  parseGroups,
  requireCanWriteFor,
  requireOfficer,
  resolveActingAccount,
  type Principal,
} from "../domain/principal.js";
import type { HistoryStore } from "../data/history.js";
import type { Repository } from "../data/repository.js";
import type { Actor } from "../data/meta.js";
import { invite, type LoginDirectory } from "../ops/invite.js";
import { resetMemberPassword } from "../ops/resetPassword.js";
import { inspectOnboardingInvite, issueOnboardingInvite, issuePasswordRecoveryInvite, redeemOnboardingInvite } from "../ops/onboardingInvites.js";
import { parseAccountOnboardingBatch, planAccountOnboarding } from "../ops/onboardAccounts.js";
import { parseResetJustification } from "../domain/access.js";
import type { TokenVerifier } from "./auth.js";
import type { EvidenceStore } from "../ops/evidenceStore.js";

export type Env = { Variables: { principal: Principal; requestId: string } };

/** Events stay visible for a while after they happened, so people can see what they missed. */
const PAST_EVENTS_MS = 7 * 24 * 60 * 60 * 1000;

/** One account's private position in a published scoreboard, without exposing anybody else's score. */
function personalEventScore(
  key: string,
  label: string,
  rows: readonly { playerId: string; points: number; precision?: EventResult["playerPoints"][number]["precision"] }[],
  playerId: string,
) {
  const ordered = [...rows].toSorted((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId));
  const mine = ordered.find((row) => row.playerId === playerId);
  if (!mine) return [];
  return [{
    key,
    label,
    points: mine.points,
    ...(mine.precision ? { precision: mine.precision } : {}),
    // Equal scores share a place; the next distinct score keeps competition ranking.
    place: ordered.findIndex((row) => row.points === mine.points) + 1,
    scoredPlayers: ordered.length,
  }];
}

/**
 * Only a positive score proves presence. A guarded bot upload is trusted as a source, but a
 * listed zero is still evidence that the player scored nothing, not that they participated.
 * This distinction matters most for complete Foundry/Canyon results: zero must be allowed to
 * fall through to an explicit absence, a signed-up no-show, or an unregistered outcome.
 */
function scoreConfirmsAttendance(row: { points: number }, _recordedBy: string): boolean {
  return row.points > 0;
}

export interface AppDeps {
  repo: Repository;
  verifier: TokenVerifier;
  now?: () => Date;
  /** Extra authenticated routes; used only by the local server for dev tools. */
  extend?: (app: Hono<Env>) => void;
  /** Kill switch: when it returns true, every route answers 503 (FM-13). */
  isPaused?: () => Promise<boolean>;
  /** Where logins live (Cognito in AWS); without it, inviting is unavailable. */
  logins?: LoginDirectory;
  /** Change history; without it, timelines are unavailable. */
  history?: HistoryStore;
  /** Live issuer-rights check. Bot tokens fail closed when no directory is configured. */
  botIssuerGroups?: BotIssuerGroups;
  /** Private immutable evidence objects (S3 in AWS). */
  evidence?: EvidenceStore;
}

/** Events far enough back to judge participation over; the domain keeps the most recent ten. */
const PARTICIPATION_DAYS = 180;
const REWARD_RECIPIENTS = 40;

export function createApp({ repo, verifier, now = () => new Date(), extend, isPaused, logins, history, botIssuerGroups: rawBotIssuerGroups = async () => undefined, evidence }: AppDeps) {
  const app = new Hono<Env>().basePath("/v1");

  const groupsFor = async (claim: unknown, linked: ReadonlySet<string>) => {
    const claimed = parseGroups(claim);
    if (claimed.has("officer") || claimed.has("owner")) return claimed;
    const accounts = await Promise.all([...linked].map((playerId) => repo.getAccount(playerId)));
    return effectiveGroups([...claimed], accounts);
  };

  // Bot tokens use the same live R4/R5-derived access as the browser instead of depending on a
  // Cognito group that may not have been manually assigned when the person was invited.
  const botIssuerGroups: BotIssuerGroups = async (issuedBy) => {
    const issuerGroups = await rawBotIssuerGroups(issuedBy);
    if (!issuerGroups) return undefined;
    const linked = new Set(await repo.linkedAccounts(issuedBy));
    return groupsFor([...issuerGroups], linked);
  };

  const requireR4 = async (principal: Principal) => {
    requireOfficer(principal);
    const playerId = defaultActing(principal);
    const account = playerId ? await repo.getAccount(playerId) : undefined;
    if (!account || (account.rank !== "R4" && account.rank !== "R5")) {
      throw new ForbiddenError("Only an R4 or R5 can manage Fortress buffs.");
    }
    return account;
  };

  const requireBotIssuerR4 = async (issuedBy: string) => {
    const accounts = await Promise.all((await repo.linkedAccounts(issuedBy)).map((playerId) => repo.getAccount(playerId)));
    const account = accounts.find(grantsOfficerAccess);
    if (!account) throw new ForbiddenError("The person who issued this bot token is no longer an R4 or R5 in POP.");
    return account;
  };

  /** One analytics row per person: linked alts stay separate in storage but roll into the main. */
  const attendancePeople = async (accounts: GameAccount[]) => {
    const byId = new Map(accounts.map((account) => [account.playerId, account]));
    const linked = await repo.linkedAccountGroups(accounts.map((account) => account.playerId));
    const groupedIds = new Set(linked.flat());
    return [
      ...linked.map((ids) => ids.flatMap((id) => byId.get(id) ?? [])),
      ...accounts.filter((account) => !groupedIds.has(account.playerId)).map((account) => [account]),
    ].filter((group) => group.length > 0);
  };

  const membershipAuditFor = async (accounts: readonly GameAccount[]): Promise<IdentityAuditRecord[]> =>
    (await Promise.all(accounts.map((account) => repo.listIdentityAudit(account.playerId)))).flat();

  const membershipContextFor = async (accounts: readonly GameAccount[]): Promise<{ audits: IdentityAuditRecord[]; periods: MembershipPeriod[] }> => {
    const audits = await membershipAuditFor(accounts);
    const currentlyIncluded = accounts.some((account) => account.status === "active" || account.status === "unknown" || account.status === "guest");
    return { audits, periods: membershipPeriods(
      accounts.map((account) => account.createdAt).filter((value): value is string => Boolean(value)),
      audits,
      currentlyIncluded,
    ) };
  };

  const membershipPeriodsFor = async (accounts: readonly GameAccount[]): Promise<MembershipPeriod[]> =>
    (await membershipContextFor(accounts)).periods;

  const attendanceForPerson = (
    attendance: Awaited<ReturnType<Repository["listAttendance"]>>,
    ids: ReadonlySet<string>,
    scored = new Set<string>(),
    noShows = new Set<string>(),
  ) => {
    const records = attendance.filter((record) => ids.has(record.playerId));
    if ([...ids].some((id) => scored.has(id)) || records.some((record) => record.status === "present")) return "present" as const;
    if ([...ids].some((id) => noShows.has(id))) return "absent" as const;
    if (records.some((record) => record.status === "absent")) return "absent" as const;
    if (records.some((record) => record.status === "excused")) return "excused" as const;
    return undefined;
  };

  const withKnownResultRoles = async (result: EventResult): Promise<EventResult> => {
    const lineup = await repo.getLineup(result.eventId, result.sessionId);
    if (!lineup) return result;
    const roleByPlayer = new Map(lineup.entries.map((entry) => [
      entry.playerId,
      entry.role === "sub" ? "substitute" as const : "starter" as const,
    ] as const));
    return {
      ...result,
      playerPoints: result.playerPoints.map((row) => row.role || !roleByPlayer.has(row.playerId)
        ? row
        : { ...row, role: roleByPlayer.get(row.playerId)! }),
    };
  };

  /** Positive points prove presence; listed rows in an approved officer-bot result are trusted too. */
  const resultEvidence = async (events: readonly AllianceEvent[]) => {
    const byEvent = new Map<string, Set<string>>();
    const byPlayer = new Map<string, Set<string>>();
    const noShowByEvent = new Map<string, Set<string>>();
    const noShowByPlayer = new Map<string, Set<string>>();
    const sessionByEventPlayer = new Map<string, string>();
    const completeEvents = new Set<string>();
    await Promise.all(events.map(async (event) => {
      const [sessionResults, phaseResults] = await Promise.all([
        repo.listResults(event.eventId),
        Promise.all(phasesForEvent(event.kind).map((phase) => repo.getEventPhaseScores(event.eventId, phase.key))),
      ]);
      const players = new Set([
        ...sessionResults.flatMap((result) => result.playerPoints
          .filter((row) => scoreConfirmsAttendance(row, result.recordedBy))
          .map((row) => row.playerId)),
        ...phaseResults.flatMap((result) => (result?.playerPoints ?? [])
          .filter((row) => scoreConfirmsAttendance(row, result?.recordedBy ?? ""))
          .map((row) => row.playerId)),
      ]);
      const noShows = new Set([
        ...sessionResults.flatMap((result) => result.playerPoints
          .filter((row) => row.points === 0)
          .map((row) => row.playerId)),
        ...phaseResults.flatMap((result) => (result?.playerPoints ?? [])
          .filter((row) => row.points === 0)
          .map((row) => row.playerId)),
      ]);
      // Foundry and Canyon results come from complete alliance battle rosters. State-wide
      // SVS/KOI/FDT leaderboards may stop at the global top 100, so they are complete only
      // when every configured phase was explicitly imported with complete coverage.
      if (
        (event.kind === "foundry" || event.kind === "canyon")
        && sessionResults.some((result) => result.playerPoints.length > 0)
      ) {
        completeEvents.add(event.eventId);
      } else if (
        phaseResults.length > 0
        && phaseResults.every((result) => result?.coverage === "complete")
      ) {
        completeEvents.add(event.eventId);
      }
      for (const result of sessionResults) {
        for (const row of result.playerPoints.filter((entry) => scoreConfirmsAttendance(entry, result.recordedBy))) {
          sessionByEventPlayer.set(`${event.eventId}#${row.playerId}`, result.sessionId);
        }
      }
      byEvent.set(event.eventId, players);
      noShowByEvent.set(event.eventId, noShows);
      for (const playerId of players) {
        const eventIds = byPlayer.get(playerId) ?? new Set<string>();
        eventIds.add(event.eventId);
        byPlayer.set(playerId, eventIds);
      }
      for (const playerId of noShows) {
        const eventIds = noShowByPlayer.get(playerId) ?? new Set<string>();
        eventIds.add(event.eventId);
        noShowByPlayer.set(playerId, eventIds);
      }
    }));
    return { byEvent, byPlayer, noShowByEvent, noShowByPlayer, sessionByEventPlayer, completeEvents };
  };

  /**
   * Explain which linked account supplied a person's event evidence. Participation remains one
   * result per occurrence (including one shared Foundry result for L1/L2), while officers can
   * still see the exact account and session behind it.
   */
  const explainPersonParticipation = (
    participation: ReturnType<typeof participationOf>,
    events: readonly AllianceEvent[],
    accounts: readonly GameAccount[],
    answers: readonly EventAnswer[],
    attendance: Awaited<ReturnType<Repository["attendanceFor"]>>,
    scores: Awaited<ReturnType<typeof resultEvidence>>,
  ) => {
    const accountById = new Map(accounts.map((account) => [account.playerId, account]));
    const eventById = new Map(events.map((event) => [event.eventId, event]));
    const occurrenceEvents = new Map<string, AllianceEvent[]>();
    for (const event of events) {
      const key = eventOccurrenceKey(event);
      occurrenceEvents.set(key, [...(occurrenceEvents.get(key) ?? []), event]);
    }
    const sessionLabel = (event: AllianceEvent, sessionId?: string) =>
      sessionId ? event.sessions.find((session) => session.id === sessionId)?.label : undefined;

    return {
      ...participation,
      events: participation.events.map((item) => {
        const representative = eventById.get(item.eventId);
        if (!representative) return item;
        const relatedIds = new Set((occurrenceEvents.get(eventOccurrenceKey(representative)) ?? [representative]).map((event) => event.eventId));
        const present = attendance.find((record) => relatedIds.has(record.eventId) && record.status === "present");
        const scored = [...relatedIds].flatMap((eventId) => accounts
          .filter((account) => scores.byEvent.get(eventId)?.has(account.playerId))
          .map((account) => ({
            eventId,
            playerId: account.playerId,
            sessionId: scores.sessionByEventPlayer.get(`${eventId}#${account.playerId}`),
          }))).at(0);
        const zeroScore = [...relatedIds].flatMap((eventId) => accounts
          .filter((account) => scores.noShowByEvent.get(eventId)?.has(account.playerId))
          .map((account) => ({ eventId, playerId: account.playerId }))).at(0);
        const selected = answers.find((answer) => relatedIds.has(answer.eventId) && answer.answer === "yes");
        const answered = answers.find((answer) => relatedIds.has(answer.eventId));
        const recorded = attendance.find((record) => relatedIds.has(record.eventId));
        const evidence = present ?? scored ?? zeroScore ?? selected ?? answered ?? recorded;
        if (!evidence) return item;
        const playerId = evidence.playerId;
        const evidenceEvent = eventById.get("eventId" in evidence ? evidence.eventId : item.eventId) ?? representative;
        const explicitSessionId = "sessionId" in evidence && typeof evidence.sessionId === "string" ? evidence.sessionId : undefined;
        const inferredSession = evidenceEvent.kind === "foundry"
          ? evidenceEvent.title.match(/Legion\s+\d+/i)?.[0]
          : undefined;
        const evidenceAccountName = accountById.get(playerId)?.name;
        const evidenceSessionLabel = sessionLabel(evidenceEvent, explicitSessionId) ?? inferredSession;
        return {
          ...item,
          evidencePlayerId: playerId,
          ...(evidenceAccountName ? { evidenceAccountName } : {}),
          ...(evidenceSessionLabel ? { evidenceSessionLabel } : {}),
        };
      }),
    };
  };

  const personAnswers = (answers: readonly EventAnswer[]) => {
    const priority = { yes: 3, maybe: 2, no: 1 } as const;
    const byEvent = new Map<string, EventAnswer>();
    for (const answer of answers) {
      const existing = byEvent.get(answer.eventId);
      if (!existing || priority[answer.answer] > priority[existing.answer]) byEvent.set(answer.eventId, answer);
    }
    return [...byEvent.values()];
  };

  const personAttendance = (records: Awaited<ReturnType<Repository["attendanceFor"]>>) => {
    const priority = { present: 4, absent: 3, excused: 2, unknown: 1 } as const;
    const byEvent = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const existing = byEvent.get(record.eventId);
      if (!existing || priority[record.status] > priority[existing.status]) byEvent.set(record.eventId, record);
    }
    return [...byEvent.values()];
  };

  const groupAttendanceOccurrences = <T extends { event: AllianceEvent }>(items: readonly T[]) => {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      const key = eventOccurrenceKey(item.event);
      const group = grouped.get(key) ?? [];
      group.push(item);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  };

  type AttendanceEvidenceItem = {
    event: AllianceEvent;
    attendance: Awaited<ReturnType<Repository["listAttendance"]>>;
    scored: Set<string>;
    noShows: Set<string>;
  };

  const attendanceOccurrenceCoverage = (
    occurrence: readonly AttendanceEvidenceItem[],
    completeEvents: ReadonlySet<string>,
  ): "complete" | "partial" => occurrence.some(({ event }) => completeEvents.has(event.eventId)) ? "complete" : "partial";

  const attendanceOccurrenceHasEvidence = (occurrence: readonly AttendanceEvidenceItem[]) => occurrence.some(
    ({ attendance, scored, noShows }) => scored.size > 0
      || noShows.size > 0
      || attendance.some((record) => record.status === "present" || record.status === "absent" || record.status === "excused"),
  );

  const attendanceStatusForOccurrence = (
    occurrence: readonly AttendanceEvidenceItem[],
    ids: ReadonlySet<string>,
  ) => attendanceForPerson(
    occurrence.flatMap((item) => item.attendance),
    ids,
    new Set(occurrence.flatMap((item) => [...item.scored])),
    new Set(occurrence.flatMap((item) => [...item.noShows])),
  );

  const fortressRewardRanking = async (alliance: string) => {
    const at = now();
    const from = new Date(at.getTime() - PARTICIPATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const events = await repo.listEvents(alliance, from, 100);
    const scores = await resultEvidence(events);
    const accounts = (await repo.listAccounts(alliance)).filter(
      (account) => account.status === "active" || account.status === "unknown",
    );
    const people = await attendancePeople(accounts);
    const details = await Promise.all(
      people.map(async (personAccounts) => {
        // Explicit identity groups are ordered with their main account first. Ranking a
        // person once prevents secondary accounts from consuming extra reward places.
        const account = personAccounts[0]!;
        const [rawAnswers, rawAttendance, reportGroups, kudosGroups] = await Promise.all([
          Promise.all(personAccounts.map((item) => repo.answersForAccount(item.playerId, from))).then((items) => items.flat()),
          Promise.all(personAccounts.map((item) => repo.attendanceFor(item.playerId))).then((items) => items.flat()),
          Promise.all(personAccounts.map((item) => repo.listReports(item.playerId))),
          Promise.all(personAccounts.map((item) => repo.listKudos(item.playerId))),
        ]);
        const strength = Math.max(0, ...reportGroups.map((reports) => currentOf(reports, "foundry_strength") ?? 0));
        const periods = await membershipPeriodsFor(personAccounts);
        const participation = participationOf({
          events,
          answers: personAnswers(rawAnswers),
          attendance: personAttendance(rawAttendance),
          scoreEvidence: [...new Set(personAccounts.flatMap((item) => [...(scores.byPlayer.get(item.playerId) ?? [])]))],
          noShowEvidence: [...new Set(personAccounts.flatMap((item) => [...(scores.noShowByPlayer.get(item.playerId) ?? [])]))],
          completeEvidence: [...scores.completeEvents],
          now: at,
          membershipPeriods: periods,
        });
        const kudos = kudosScore(
          kudosGroups.flat().filter((award) => wasMemberAt(periods, award.awardedAt)),
          at,
        );
        // Match the established scoring rule: unknown attendance is neutral (fully reliable),
        // never a silent penalty for a member whose history has not been recorded yet.
        return {
          account,
          playerIds: personAccounts.map((item) => item.playerId),
          strength,
          participationRate: participation.rate ?? 1,
          participationSample: participation.sample,
          participationAttended: participation.attended,
          participationNoShows: participation.noShows,
          participationUnregistered: participation.unregistered,
          kudos,
        };
      }),
    );
    const strongest = Math.max(0, ...details.map((detail) => detail.strength));
    const bestKudos = Math.max(0, ...details.map((detail) => detail.kudos));
    const ranked = details
      .map((detail) => {
        const kudosPart = kudosShare(detail.kudos, bestKudos);
        return {
          ...detail,
          kudosShare: kudosPart,
          score: buffScore({
            attendanceRate: detail.participationRate,
            strength: detail.strength,
            strongest,
            kudosShare: kudosPart,
          }),
        };
      })
      .toSorted((a, b) => b.score - a.score || a.account.name.localeCompare(b.account.name));
    return { accounts, ranked, strongest, bestKudos };
  };

  const fortressBuffView = async (pool: FortressBuffPool, principal: Principal) => {
    const { accounts, ranked: allRanked, strongest } = await fortressRewardRanking(pool.alliance);
    const assignments = await repo.listFortressBuffAssignments(pool.poolId);
    const assigned = new Set(assignments.map((assignment) => assignment.playerId));
    const cycleKey = (item: FortressBuffPool) => item.batchId ?? `legacy:${item.acquiredAt}:${item.source}:${item.createdBy}`;
    const cyclePools = (await repo.listFortressBuffPools(pool.alliance)).filter((item) => cycleKey(item) === cycleKey(pool));
    const cycleAssignments = await Promise.all(cyclePools.map(async (item) => ({
      pool: item,
      assignments: await repo.listFortressBuffAssignments(item.poolId),
    })));
    const received = new Map<string, { min: number; max: number; unvaluedUnits: number }>();
    for (const item of cycleAssignments) {
      for (const assignment of item.assignments) {
        const current = received.get(assignment.playerId) ?? { min: 0, max: 0, unvaluedUnits: 0 };
        if (item.pool.gemValuation) {
          current.min += assignment.amount * item.pool.gemValuation.min;
          current.max += assignment.amount * item.pool.gemValuation.max;
        } else {
          current.unvaluedUnits += assignment.amount;
        }
        received.set(assignment.playerId, current);
      }
    }
    const eligibleCount = Math.min(REWARD_RECIPIENTS, allRanked.length);
    const eligibleRanked = allRanked.slice(0, eligibleCount);
    const scoreTotal = eligibleRanked.reduce((sum, candidate) => sum + Math.max(0, candidate.score), 0);
    const knownCycleValue = cyclePools.reduce((total, item) => ({
      min: total.min + (item.gemValuation ? item.quantity * item.gemValuation.min : 0),
      max: total.max + (item.gemValuation ? item.quantity * item.gemValuation.max : 0),
    }), { min: 0, max: 0 });
    const shareOf = (playerId: string) => {
      const candidate = eligibleRanked.find((item) => item.account.playerId === playerId);
      if (!candidate) return 0;
      return scoreTotal > 0 ? Math.max(0, candidate.score) / scoreTotal : 1 / Math.max(1, eligibleCount);
    };
    const targetOf = (playerId: string) => ({
      min: knownCycleValue.min * shareOf(playerId),
      max: knownCycleValue.max * shareOf(playerId),
    });

    // Plan valuable pools first. Each unit goes to the eligible member furthest below
    // their score-weighted cycle target; smaller divisible items then fill the gaps.
    const plannedValue = new Map(eligibleRanked.map((candidate) => {
      const current = received.get(candidate.account.playerId) ?? { min: 0, max: 0 };
      return [candidate.account.playerId, (current.min + current.max) / 2] as const;
    }));
    const recommendations = new Map<string, Map<string, number>>();
    const valuedPools = cycleAssignments
      .filter((item) => item.pool.gemValuation && item.pool.remaining > 0)
      .toSorted((a, b) => {
        const aValue = (a.pool.gemValuation!.min + a.pool.gemValuation!.max) / 2;
        const bValue = (b.pool.gemValuation!.min + b.pool.gemValuation!.max) / 2;
        return bValue - aValue;
      });
    for (const item of valuedPools) {
      const unitValue = (item.pool.gemValuation!.min + item.pool.gemValuation!.max) / 2;
      const alreadyAssigned = new Set(item.assignments.map((assignment) => assignment.playerId));
      const poolPlan = new Map<string, number>();
      // Complete distribution rounds keep one high-ranked member from monopolising a
      // repeatable 12-hour buff. Rank decides who receives the remainder of a round.
      const maxPerMember = Math.max(1, Math.ceil(item.pool.quantity / Math.max(1, eligibleCount)));
      for (let unit = 0; unit < item.pool.remaining; unit += 1) {
        const recipient = eligibleRanked
          .filter((candidate) => !alreadyAssigned.has(candidate.account.playerId) && (poolPlan.get(candidate.account.playerId) ?? 0) < maxPerMember)
          .map((candidate) => {
            const playerId = candidate.account.playerId;
            const target = targetOf(playerId);
            const targetMidpoint = (target.min + target.max) / 2;
            return { playerId, deficit: targetMidpoint - (plannedValue.get(playerId) ?? 0), position: allRanked.indexOf(candidate) + 1 };
          })
          .toSorted((a, b) => b.deficit - a.deficit || a.position - b.position)[0];
        if (!recipient) break;
        poolPlan.set(recipient.playerId, (poolPlan.get(recipient.playerId) ?? 0) + 1);
        plannedValue.set(recipient.playerId, (plannedValue.get(recipient.playerId) ?? 0) + unitValue);
      }
      recommendations.set(item.pool.poolId, poolPlan);
    }
    const ranked = allRanked
      .map((detail, index) => ({ detail, position: index + 1 }))
      .filter(({ detail }) => !assigned.has(detail.account.playerId));
    const names = new Map(accounts.map((account) => [account.playerId, account.name]));
    const acting = defaultActing(principal);
    return {
      ...pool,
      assignments: assignments.map((assignment) => {
        const { eligibility, ...publicAssignment } = assignment;
        return {
          ...publicAssignment,
          ...(eligibility && (isOfficer(principal) || acting === assignment.playerId) ? { eligibility } : {}),
          name: names.get(assignment.playerId) ?? assignment.playerId,
        };
      }),
      candidates: ranked.map(({ detail: candidate, position }) => ({
        playerId: candidate.account.playerId,
        name: candidate.account.name,
        position,
        eligible: position <= Math.min(REWARD_RECIPIENTS, allRanked.length),
        cycleRewardValueMin: received.get(candidate.account.playerId)?.min ?? 0,
        cycleRewardValueMax: received.get(candidate.account.playerId)?.max ?? 0,
        cycleUnvaluedUnits: received.get(candidate.account.playerId)?.unvaluedUnits ?? 0,
        cycleTargetValueMin: targetOf(candidate.account.playerId).min,
        cycleTargetValueMax: targetOf(candidate.account.playerId).max,
        recommendedAmount: recommendations.get(pool.poolId)?.get(candidate.account.playerId) ?? 0,
        ...(isOfficer(principal)
          ? {
              score: candidate.score,
              participationRate: candidate.participationRate,
              strength: candidate.strength,
              strongestStrength: strongest,
              strengthShare: strongest > 0 ? candidate.strength / strongest : 0,
              kudosShare: candidate.kudosShare,
            }
          : {}),
      })),
    };
  };

  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? ulid());
    await next();
    c.header("x-request-id", c.get("requestId"));
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      console.warn(JSON.stringify({
        level: "warn",
        source: "api",
        kind: "domain_error",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: err.status,
        errorCode: err.code,
        message: err.message,
      }));
      return c.json(
        { type: `about:blank#${err.code}`, title: err.message, status: err.status, detail: err.details, requestId: c.get("requestId") },
        err.status as 400,
        { "content-type": "application/problem+json" },
      );
    }
    console.error(JSON.stringify({
      level: "error",
      source: "api",
      kind: "unhandled_error",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: 500,
      errorName: err instanceof Error ? err.name : "UnknownError",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    }));
    return c.json({ type: "about:blank", title: "Internal error", status: 500, requestId: c.get("requestId") }, 500, {
      "content-type": "application/problem+json",
    });
  });

  app.notFound((c) =>
    c.json({ type: "about:blank#not_found", title: "Not found", status: 404 }, 404, {
      "content-type": "application/problem+json",
    }),
  );

  // Runs before auth and before any database call, so a paused API costs almost nothing.
  if (isPaused) {
    app.use("*", async (c, next) => {
      if (!(await isPaused())) return next();
      return c.json(
        { type: "about:blank#paused", title: "POP HQ is paused. Please try again later.", status: 503 },
        503,
        { "content-type": "application/problem+json", "retry-after": "3600" },
      );
    });
  }

  app.get("/health", (c) => c.json({ status: "ok" }));

  const ministryDayView = (round: SvsRound, bookings: readonly MinistryBooking[], playerId?: string) =>
    round.days.map((day) => {
      const taken = new Set(bookings.filter((booking) => booking.dayId === day.id).map((booking) => booking.slot));
      const activeProtections = (round.protections ?? []).filter((protection) => protection.dayId === day.id && Date.parse(protection.releasesAt) > now().getTime());
      const protectedForOthers = new Set(activeProtections
        .filter((protection) => !playerId || !protection.eligiblePlayerIds.includes(playerId))
        .flatMap((protection) => protection.slots));
      const prioritySlots = activeProtections
        .filter((protection) => playerId && protection.eligiblePlayerIds.includes(playerId))
        .flatMap((protection) => protection.slots);
      return {
        ...day,
        startsAt: slotStartsAt(day, 0),
        endsAt: dayEndsAt(day),
        freeSlots: Array.from({ length: SLOTS_PER_DAY }, (_, slot) => slot)
          .filter((slot) => !taken.has(slot) && !protectedForOthers.has(slot) && Date.parse(slotStartsAt(day, slot)) > now().getTime()),
        prioritySlots,
      };
    });

  const publicMinistryRound = async (roundId: string) => {
    const round = await repo.getRound(roundId);
    if (!round || !round.bookingEnabled) throw new NotFoundError("Ministry booking is not open.");
    const bookings = await repo.listMinistryBookings(round.roundId);
    return {
      roundId: round.roundId,
      label: round.label,
      alliance: round.alliance,
      term: ministryTerm(round),
      state: roundState(round, now()),
      days: ministryDayView(round, bookings),
    };
  };
  const guestManageUntil = (round: SvsRound) => {
    const { endsOn } = ministryTerm(round);
    return new Date(Date.parse(`${endsOn}T00:00:00.000Z`) + 8 * 24 * 60 * 60 * 1000).toISOString();
  };

  /** Public guest surface exposes only open times—never another player's booking or identity. */
  app.get("/ministry/public/terms", async (c) => {
    const from = new Date(now().getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rounds = await repo.listRounds("POP", from);
    const items = await Promise.all(rounds
      .filter((round) => round.bookingEnabled && ministryTerm(round).endsOn >= now().toISOString().slice(0, 10))
      .map((round) => publicMinistryRound(round.roundId)));
    return c.json({ items });
  });

  app.get("/ministry/public/terms/:id", async (c) => c.json(await publicMinistryRound(c.req.param("id"))));

  app.post("/ministry/public/terms/:id/book", async (c) => {
    const input = parseGuestBooking(await readJson(c.req.raw));
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Ministry term not found.");
    if (!round.bookingEnabled) throw new ConflictError("POP does not currently have the Ministry, so booking is not open.");
    validateClaim(round, input, now());
    if ((round.protections ?? []).some((protection) => protection.dayId === input.dayId && protection.slots.includes(input.slot) && Date.parse(protection.releasesAt) > now().getTime())) {
      throw new ConflictError("That time is reserved for rally leads until its public release time.");
    }
    const known = await repo.getAccount(input.playerId);
    if (known && known.status === "active") throw new ConflictError("This Player ID belongs to a POP member. Sign in to book instantly with your saved details.");
    const secret = newGuestSecret();
    const booking: MinistryBooking = {
      bookingId: ulid(),
      roundId: round.roundId,
      dayId: input.dayId,
      slot: input.slot,
      kind: "guest",
      bookerKey: `GUEST#${input.playerId}`,
      playerId: input.playerId,
      playerName: input.playerName,
      alliance: input.alliance,
      createdAt: now().toISOString(),
    };
    await repo.claimMinistryBooking(booking, { id: `guest:${booking.bookingId}`, via: "web", reason: "guest Ministry booking" }, secret.tokenHash);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.json({ booking, token: secret.token, manageUntil: guestManageUntil(round), term: ministryTerm(round), day: round.days.find((day) => day.id === booking.dayId) }, 201);
  });

  app.post("/ministry/public/manage", async (c) => {
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const booking = await repo.getMinistryBookingByGuestToken(ministryGuestTokenHash(body.token));
    if (!booking) throw new NotFoundError("This booking link is invalid or the booking was cancelled.");
    const round = await repo.getRound(booking.roundId);
    if (!round) throw new NotFoundError("Ministry term not found.");
    if (Date.parse(guestManageUntil(round)) <= now().getTime()) throw new NotFoundError("This private booking link has expired.");
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.json({ booking, manageUntil: guestManageUntil(round), term: ministryTerm(round), day: round.days.find((day) => day.id === booking.dayId) });
  });

  app.post("/ministry/public/manage/cancel", async (c) => {
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const tokenHash = ministryGuestTokenHash(body.token);
    const booking = await repo.getMinistryBookingByGuestToken(tokenHash);
    if (!booking) throw new NotFoundError("This booking link is invalid or the booking was cancelled.");
    const round = await repo.getRound(booking.roundId);
    if (!round) throw new NotFoundError("Ministry term not found.");
    if (Date.parse(`${ministryTerm(round).endsOn}T23:59:59.999Z`) <= now().getTime()) throw new ConflictError("This Ministry term has ended, so the appointment can no longer be changed.");
    await repo.cancelMinistryBooking(booking, { id: `guest:${booking.bookingId}`, via: "web", reason: "guest cancelled Ministry booking" }, tokenHash);
    return c.json({ cancelled: true });
  });

  // Public bearer-link endpoints intentionally live before authentication. The secret is sent in
  // a JSON body (the browser receives it as a URL fragment), never in a request URL or server log.
  if (logins) {
    app.post("/onboarding-invitations/inspect", async (c) => {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new ValidationError("Request body must be JSON.");
      }
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const result = await inspectOnboardingInvite(repo, body.token, now());
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.json(result.public);
    });

    app.post("/onboarding-invitations/redeem", async (c) => {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new ValidationError("Request body must be JSON.");
      }
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const result = await redeemOnboardingInvite(
        { repo, logins, at: now() },
        { token: body.token, method: body.method, email: body.email, loginName: body.loginName },
      );
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.json(result, 201);
    });
  }

  // Bot-specific surface. Normal GET routes also accept bot tokens as their live issuer;
  // normal write routes do not. Dry-run is the default for the one scoped bot write.
  app.get("/agent/doctor", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    return c.json({ status: "ok", tokenId: token.tokenId, scopes: effectiveBotScopes(token), expiresAt: token.expiresAt });
  });

  /** Exact canonical/alias resolver for guarded import workflows; never fuzzy-matches. */
  app.get("/agent/accounts/resolve-name", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    const alliance = (c.req.query("alliance") ?? "POP").trim().toUpperCase();
    if (alliance !== "POP") throw new ValidationError("Only the POP alliance registry is available to this bot.");
    const query = parseGameName(c.req.query("name"));
    const matches = await repo.resolveAccountName(alliance, query);
    return c.json({
      query,
      alliance,
      matching: "NFKC, case-insensitive, collapsed whitespace; punctuation and digits retained",
      ambiguous: matches.length > 1,
      resolved: matches.length === 1 ? matches[0] : null,
      matches,
    });
  });

  /** Officer-only exact-ID readback for shell reconciliation; login subjects stay private. */
  app.get("/agent/accounts/:pid/reconciliation", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account) throw new NotFoundError(`Game account ${playerId} not found.`);
    const [aliases, access, evidence, historicalNames] = await Promise.all([
      repo.listAliases(playerId),
      repo.linkedLoginAccess(playerId),
      repo.listHistoricalRecords("evidence"),
      repo.listHistoricalRecords("alias"),
    ]);
    const sourceRecords = [...evidence, ...historicalNames].filter((record) => record.playerId === playerId);
    return c.json({
      account,
      hasLogin: Boolean(access),
      aliases,
      aliasSources: sourceRecords.filter((record) => record.category === "alias" && (record.payload as Record<string, unknown>).kind === "confirmed_account_alias"),
      sourceRecords,
    });
  });

  /** Preview or atomically apply exact-ID login-free shell onboarding and source evidence. */
  app.post("/agent/accounts/reconcile", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "accounts:write", now(), botIssuerGroups);
    await requireBotIssuerR4(token.issuedBy);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"), "account onboarding");
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) {
        if (replay.bodyHash !== write.bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ ...(replay.response as Record<string, unknown>), dryRun: false, replayed: true });
      }
      if (body.approved !== true) throw new ValidationError("Applying account onboarding requires explicit approval of the reviewed preview.");
    }
    const batch = parseAccountOnboardingBatch(body);
    const plan = await planAccountOnboarding(repo, batch);
    const { writes, ...review } = plan;
    const expectedHash = stateHash(review);
    if (!write.apply) return c.json({ dryRun: true, expectedHash, ...review });
    if (write.expectedHash !== expectedHash) throw new ConflictError("This is not the exact reviewed account preview. Preview again before applying.");
    if (!plan.applicable) throw new ConflictError("Resolve every account identity conflict before applying.", { rows: review.rows.filter((row) => row.issues.length > 0) });
    const response = { dryRun: false, replayed: false, expectedHash, ...review };
    await repo.putAccountOnboardingIdempotent(
      writes,
      agentActor(token.tokenId, write.reason),
      token.tokenId,
      write.key,
      write.bodyHash,
      response,
    );
    c.header("x-change-id", write.key);
    const changed = writes.accounts.length + writes.aliases.length + writes.evidence.length > 0;
    return c.json(response, changed ? 201 : 200);
  });

  /** Registers one complete Fortress/Stronghold haul. Preview is the default. */
  app.post("/agent/rewards", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "rewards:write",
      now(),
      botIssuerGroups,
    );
    const officer = await requireBotIssuerR4(token.issuedBy);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"), "rewards");
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "rewards");
    }
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/.test(batchId)) {
      throw new ValidationError("batchId must be 3–60 letters, digits, dots, underscores or hyphens.");
    }
    const poolIds = Object.fromEntries(
      FORTRESS_BUFFS.map((buff) => [buff, `reward-${batchId}-${buff}`]),
    ) as Record<FortressBuff, string>;
    const desired = parseFortressBuffPools(body, {
      poolIds,
      batchId,
      alliance: officer.alliance,
      createdBy: `agent:${token.tokenId}`,
      now: now(),
    });
    const current = (await Promise.all(desired.map((pool) => repo.getFortressBuffPool(pool.poolId))))
      .filter((pool): pool is FortressBuffPool => pool !== undefined);
    if (current.length > 0 && canonicalJson(current) !== canonicalJson(desired)) {
      throw new ConflictError(`Reward batch ${batchId} already exists with different data.`);
    }
    const currentHash = stateHash(current);
    if (write.apply && write.expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(desired)) {
      throw new ConflictError("Reward inventory changed after preview. Preview again before applying.");
    }
    const unchanged = canonicalJson(current) === canonicalJson(desired);
    if (!write.apply) {
      return c.json({ dryRun: true, expectedHash: currentHash, unchanged, diff: { before: current, after: desired } });
    }
    if (unchanged) {
      await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, desired);
    } else {
      await repo.putFortressBuffPoolsIdempotent(
        desired,
        agentActor(token.tokenId, write.reason),
        token.tokenId,
        write.key,
        write.bodyHash,
      );
    }
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged, rewards: desired }, unchanged ? 200 : 201);
  });

  /** Reads preserved import records that do not yet have a richer product-specific view. */
  app.get("/agent/history", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    const category = c.req.query("category");
    if (!category || !HISTORICAL_CATEGORIES.includes(category as HistoricalCategory)) {
      throw new ValidationError(`category must be one of: ${HISTORICAL_CATEGORIES.join(", ")}.`);
    }
    return c.json({ items: await repo.listHistoricalRecords(category as HistoricalCategory) });
  });

  app.get("/agent/history/evidence/:recordId/content", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    if (!evidence) throw new NotFoundError("Evidence storage is unavailable.");
    const recordId = historicalRecordId(c.req.param("recordId"));
    const object = await evidence.get(recordId);
    c.header("content-type", object.contentType);
    c.header("x-content-sha256", object.sha256);
    c.header("content-disposition", `inline; filename="${recordId}"`);
    return c.body(Buffer.from(object.content));
  });

  /** Uploads one hash-verified private evidence object; existing bytes are never overwritten. */
  app.put("/agent/history/evidence/:recordId/content", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    if (!evidence) throw new NotFoundError("Evidence storage is unavailable.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "evidence");
    }
    const recordId = historicalRecordId(c.req.param("recordId"));
    if (typeof body.contentBase64 !== "string" || body.contentBase64.length === 0) throw new ValidationError("contentBase64 is required.");
    const content = Buffer.from(body.contentBase64, "base64");
    if (content.byteLength === 0 || content.byteLength > 5 * 1024 * 1024) throw new ValidationError("Evidence content must be between 1 byte and 5 MB.");
    const canonicalBase64 = content.toString("base64").replace(/=+$/, "");
    if (canonicalBase64 !== body.contentBase64.replace(/\s+/g, "").replace(/=+$/, "")) throw new ValidationError("contentBase64 is not valid base64.");
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (typeof body.sha256 !== "string" || body.sha256.toLowerCase() !== sha256) throw new ValidationError("Evidence SHA-256 does not match its content.");
    const contentType = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    if (!/^(?:image\/(?:jpeg|png|webp)|application\/(?:pdf|json)|text\/plain)$/.test(contentType)) throw new ValidationError("Unsupported evidence content type.");
    const desired = { recordId, sha256, size: content.byteLength, contentType };
    const current = await evidence.head(recordId);
    if (current && canonicalJson(current) !== canonicalJson(desired)) throw new ConflictError(`Evidence content ${recordId} already exists with different bytes or metadata.`);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    if (!current) await evidence.put(desired, content);
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, desired);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), evidence: desired }, current ? 200 : 201);
  });

  /** Imports one immutable typed strength/power report with its original timestamps. */
  app.put("/agent/history/reports/:pid/:reportId", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason || !expectedHash) throw new ValidationError("Applying historical data requires a reason and the expectedHash from preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      const replay = await repo.getIdempotentChange(token.tokenId, key);
      if (replay) {
        if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, report: replay.response });
      }
    }
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const report = parseImportedReport(body, playerId, c.req.param("reportId"), now());
    const current = await repo.getReport(playerId, report.reportId);
    const currentHash = createHash("sha256").update(canonicalJson(current ?? null)).digest("hex");
    if (current && canonicalJson(current) !== canonicalJson(report)) throw new ConflictError(`Report ${report.reportId} already exists with different data.`);
    if (apply && expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(report)) throw new ConflictError("Report history changed after preview. Preview again before applying.");
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: report } });
    if (!current) await repo.addReport(report, { id: token.tokenId, via: `agent:${token.tokenId}`, reason });
    await repo.putIdempotentChange(token.tokenId, key, bodyHash, report);
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), report }, current ? 200 : 201);
  });

  /** Imports one historical signup/withdrawal without reopening the event. */
  app.put("/agent/history/events/:id/signups/:pid", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "signup");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const choice = parseAnswerChoice(event, body);
    const answeredAt = historicalTimestamp(body.answeredAt, "answeredAt");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : undefined;
    const desired = { eventId: event.eventId, playerId, ...choice, answeredAt, source: "import" as const, ...(note ? { note } : {}) };
    const current = await repo.getAnswer(event.eventId, playerId);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    const saved = canonicalJson(current) === canonicalJson(desired)
      ? desired
      : await repo.setAnswer(event, playerId, choice, "import", agentActor(token.tokenId, write.reason), note, { historic: true, answeredAt });
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, saved);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: canonicalJson(current) === canonicalJson(desired), signup: saved });
  });

  /** Imports one actual attendance observation, preserving its source time and evidence reference. */
  app.put("/agent/history/events/:id/attendance/:pid", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "attendance");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const parsed = parseAttendance(body);
    if (parsed.sessionId && !event.sessions.some((session) => session.id === parsed.sessionId)) throw new ValidationError("That part of the event doesn't exist.");
    const recordedAt = historicalTimestamp(body.recordedAt, "recordedAt");
    const source = ["officer", "screenshot", "agent", "import"].includes(String(body.source))
      ? body.source as "officer" | "screenshot" | "agent" | "import"
      : "import";
    const desired = { eventId: event.eventId, playerId, ...parsed, source, recordedAt };
    const current = await repo.getAttendance(event.eventId, playerId);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    const saved = canonicalJson(current) === canonicalJson(desired)
      ? desired
      : await repo.setAttendance({ eventId: event.eventId, playerId, ...parsed, source }, agentActor(token.tokenId, write.reason), recordedAt);
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, saved);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: canonicalJson(current) === canonicalJson(desired), attendance: saved });
  });

  /** Imports the reviewed starter/substitute decision for one historical event part. */
  app.put("/agent/history/events/:id/sessions/:sid/lineup", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "lineup");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const current = await repo.getLineup(event.eventId, session.id);
    const publishedAt = historicalTimestamp(body.publishedAt, "publishedAt");
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ValidationError("Historical lineups require expectedVersion.");
    const lineup = parseLineup(body, session, { eventId: event.eventId, sessionId: session.id, publishedBy: `agent:${token.tokenId}`, now: new Date(publishedAt), currentVersion: Number(body.expectedVersion) });
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = lineup.entries.filter((entry) => !known.has(entry.playerId)).map((entry) => entry.playerId);
    if (strangers.length > 0) throw new ValidationError(`Unknown Player IDs: ${strangers.join(", ")}.`);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, lineup);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: lineup } });
    if (canonicalJson(current) !== canonicalJson(lineup)) await repo.putLineup(lineup, agentActor(token.tokenId, write.reason));
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, lineup);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, lineup }, 201);
  });

  /** Imports one reviewed tactical plan; assignments must still belong to the published lineup. */
  app.put("/agent/history/events/:id/sessions/:sid/strategy", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "strategy");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const current = await repo.getStrategy(event.eventId, session.id);
    const publishedAt = historicalTimestamp(body.publishedAt, "publishedAt");
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ValidationError("Historical tactics require expectedVersion.");
    const strategy = parseStrategy(body, session, { eventId: event.eventId, sessionId: session.id, publishedBy: `agent:${token.tokenId}`, now: new Date(publishedAt), currentVersion: Number(body.expectedVersion) });
    if (strategy.assignments.length > 0) {
      const lineup = await repo.getLineup(event.eventId, session.id);
      if (!lineup) throw new ValidationError("Import the lineup before tactical assignments.");
      const selected = new Set(lineup.entries.map((entry) => entry.playerId));
      const outside = strategy.assignments.filter((assignment) => !selected.has(assignment.playerId)).map((assignment) => assignment.playerId);
      if (outside.length > 0) throw new ValidationError(`Not in the published ${session.label} lineup: ${outside.join(", ")}.`);
    }
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, strategy);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: strategy } });
    if (canonicalJson(current) !== canonicalJson(strategy)) await repo.putStrategy(strategy, agentActor(token.tokenId, write.reason));
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, strategy);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, strategy }, 201);
  });

  /** Preserves one exact, immutable source fact. Preview is the default; ids make retries stable. */
  app.put("/agent/history/:recordId", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "history:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying a historical import requires a reason.");
      if (!expectedHash) throw new ValidationError("Applying a historical import requires the expectedHash from its preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      const replay = await repo.getIdempotentChange(token.tokenId, key);
      if (replay) {
        if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, record: replay.response });
      }
    }
    const record = parseHistoricalRecord(c.req.param("recordId"), body);
    const current = await repo.getHistoricalRecord(record.category, record.recordId);
    const currentHash = createHash("sha256").update(canonicalJson(current ?? null)).digest("hex");
    if (current && canonicalJson(current) !== canonicalJson(record)) {
      throw new ConflictError(`Historical record ${record.recordId} already exists with different data.`);
    }
    if (apply && expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(record)) throw new ConflictError("Historical data changed after preview. Preview again before applying.");
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: record } });
    if (!current) await repo.createHistoricalRecord(record, { id: token.tokenId, via: `agent:${token.tokenId}`, reason });
    await repo.putIdempotentChange(token.tokenId, key, bodyHash, record);
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), record }, current ? 200 : 201);
  });

  /** Minimal event discovery for result bots; no sign-ups, notes, accounts or officer data. */
  app.get("/agent/events", async (c) => {
    await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    const requestedFrom = c.req.query("from");
    if (requestedFrom && Number.isNaN(Date.parse(requestedFrom))) throw new ValidationError("from must be an ISO date or timestamp.");
    const requestedKind = c.req.query("kind");
    if (requestedKind && !EVENT_KINDS.includes(requestedKind as EventKind)) throw new ValidationError("Unknown event kind.");
    const from = requestedFrom
      ? new Date(requestedFrom).toISOString()
      : new Date(now().getTime() - PAST_EVENTS_MS).toISOString();
    const events = await repo.listEvents("POP", from);
    return c.json({
      items: events
        .filter((event) => !requestedKind || event.kind === requestedKind)
        .map((event) => ({
          eventId: event.eventId,
          kind: event.kind,
          title: event.title,
          startsAt: event.startsAt,
          sessions: event.sessions.map((session) => ({ id: session.id, label: session.label, startsAt: session.startsAt })),
        })),
    });
  });

  /** Guarded event creation, including faithful historical events. Preview is always the default. */
  app.post("/agent/events", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "events:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying an agent event change requires a reason.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
        throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      }
      const previous = await repo.getIdempotentEvent(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, event: previous.event });
      }
    }
    const event = parseAgentNewEvent(body, {
      createdBy: `agent:${token.tokenId}`,
      now: now(),
    });
    if (await repo.getEvent(event.eventId)) throw new ConflictError(`Event ${event.eventId} already exists.`);
    if (!apply) return c.json({ dryRun: true, diff: { before: null, after: event } });
    await repo.putEventIdempotent(
      event,
      "create",
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason },
      token.tokenId,
      key,
      bodyHash,
    );
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, event }, 201);
  });

  /** Guarded event/session metadata editing. Existing session ids remain durable foreign keys. */
  app.patch("/agent/events/:id", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "events:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying an agent event change requires a reason.");
      if (!expectedHash) throw new ValidationError("Applying an event edit requires the expectedHash from its preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
        throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      }
      const previous = await repo.getIdempotentEvent(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, event: previous.event });
      }
    }
    const current = await repo.getEvent(c.req.param("id"));
    if (!current) throw new NotFoundError("Event not found.");
    const currentHash = createHash("sha256").update(canonicalJson(current)).digest("hex");
    if (apply && expectedHash !== currentHash) {
      throw new ConflictError("The event changed after preview. Preview the edit again before applying it.");
    }
    const updated = parseAgentEventChanges(current, body, now());
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current, after: updated } });
    await repo.putEventIdempotent(
      updated,
      "update",
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason },
      token.tokenId,
      key,
      bodyHash,
      current,
    );
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, event: updated });
  });

  /** Guarded, named-only registration upsert. It never publishes a lineup or attendance. */
  app.put("/agent/events/:id/registrations", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "registrations:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"), "event registrations");
    if (write.apply) {
      if (body.approved !== true) throw new ValidationError("Applying event registrations requires explicit approval.");
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "result");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    if (Date.parse(event.startsAt) <= now().getTime()) throw new ConflictError("Registrations cannot be changed after the event starts.");
    const requested = parseAgentEventRegistrations(event, body);
    const accounts = await Promise.all(requested.map((row) => repo.getAccount(row.playerId)));
    const invalid = requested.filter((row, index) => {
      const account = accounts[index];
      return !account || account.alliance !== event.alliance || !["active", "guest", "unknown"].includes(account.status);
    }).map((row) => row.playerId);
    if (invalid.length > 0) throw new ValidationError("Some registrations reference unavailable Player IDs.", { playerIds: invalid });

    const current = await Promise.all(requested.map((row) => repo.getAnswer(event.eventId, row.playerId)));
    const semantic = (answer: EventAnswer | undefined) => answer ? {
      playerId: answer.playerId,
      answer: answer.answer,
      sessionId: answer.sessionId ?? null,
      role: answer.registrationRole ?? null,
    } : null;
    const desired = requested.map((row) => ({
      playerId: row.playerId,
      answer: row.answer,
      sessionId: row.sessionId,
      role: row.role ?? null,
    }));
    const previewState = {
      event: { eventId: event.eventId, startsAt: event.startsAt, sessions: event.sessions },
      before: current.map(semantic),
      after: desired,
    };
    const expectedHash = stateHash(previewState);
    if (write.apply && write.expectedHash !== expectedHash) {
      throw new ConflictError("The event or a named registration changed after preview. Preview again before applying.");
    }
    const diff = requested.map((row, index) => ({ before: semantic(current[index]), after: desired[index] }));
    if (!write.apply) return c.json({ dryRun: true, expectedHash, event: previewState.event, diff });

    const appliedAt = now().toISOString();
    const changed = requested.flatMap((row, index) => {
      const before = current[index];
      if (canonicalJson(semantic(before)) === canonicalJson(desired[index])) return [];
      const after: EventAnswer = {
        eventId: event.eventId,
        playerId: row.playerId,
        answer: "yes",
        sessionId: row.sessionId,
        ...(row.role ? { registrationRole: row.role } : {}),
        answeredAt: appliedAt,
        source: "officer",
        ...(before?.note ? { note: before.note } : {}),
      };
      return [{ before, after }];
    });
    const saved = requested.map((row, index) => {
      const updated = changed.find((entry) => entry.after.playerId === row.playerId)?.after;
      return updated ?? current[index]!;
    });
    const result = {
      event: previewState.event,
      changed: changed.length,
      unchanged: requested.length - changed.length,
      registrations: saved,
      diff,
    };
    await repo.putEventRegistrationsIdempotent(
      event,
      changed,
      saved.filter((answer) => !changed.some((entry) => entry.after.playerId === answer.playerId)),
      agentActor(token.tokenId, write.reason),
      token.tokenId,
      write.key,
      write.bodyHash,
      result,
    );
    const readback = await Promise.all(requested.map((row) => repo.getAnswer(event.eventId, row.playerId)));
    if (canonicalJson(readback) !== canonicalJson(saved)) {
      throw new ConflictError("Registrations were saved but exact readback did not match. Stop and inspect before retrying.");
    }
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, result });
  });

  app.get("/agent/events/:id/sessions/:sid/result-context", async (c) => {
    const { issuerGroups } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "all:read",
      now(),
      botIssuerGroups,
    );
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const accountList = await repo.listAccounts(event.alliance);
    const accounts = new Map(accountList.map((account) => [account.playerId, account.name]));
    const lineup = await repo.getLineup(event.eventId, session.id);
    return c.json({
      event: { eventId: event.eventId, title: event.title, kind: event.kind },
      session,
      lineup: lineup?.entries.map((entry) => ({ ...entry, name: accounts.get(entry.playerId) ?? entry.playerId })) ?? [],
      // Officers can already read this registry through /roster. Returning the same exact ids and
      // names here lets result bots map a legacy scoreboard without pretending it had a lineup.
      ...([...issuerGroups].some((group) => group === "officer" || group === "owner")
        ? { players: accountList.map(({ playerId, name }) => ({ playerId, name })) }
        : {}),
      result: (await repo.getResult(event.eventId, session.id)) ?? null,
    });
  });

  app.put("/agent/events/:id/sessions/:sid/result", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "results:write", now(), botIssuerGroups);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    if (Date.parse(session.startsAt) > now().getTime()) throw new ValidationError("Record the result after this event part starts.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const key = c.req.header("idempotency-key") ?? "";
    const write = agentWriteRequest(body, apply, key, "an agent result");
    if (apply) {
      if (body.approved !== true) throw new ValidationError("Applying an agent result requires explicit approval of the preview.");
      // Replay before version validation: the original request legitimately carries the old
      // expectedVersion after its first successful application.
      const previous = await repo.getIdempotentResult(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== write.bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, result: previous.result });
      }
    }
    const current = await repo.getResult(event.eventId, session.id);
    if (typeof body.expectedVersion === "number" && body.expectedVersion !== (current?.version ?? 0)) {
      throw new ConflictError("The event result changed. Fetch context and preview again before applying.");
    }
    const result = await withKnownResultRoles(parseEventResult(body, session, {
      eventId: event.eventId,
      eventKind: event.kind,
      recordedBy: `agent:${token.tokenId}`,
      now: now(),
      currentVersion: current?.version ?? 0,
    }));
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = result.playerPoints.filter((row) => !known.has(row.playerId)).map((row) => row.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    const diff = { before: current ?? null, after: result };
    // recordedAt is generated by the server and can cross a clock tick between preview and
    // apply. Bind approval to the complete semantic result and current state, not wall time.
    const semanticResult = Object.fromEntries(Object.entries(result).filter(([field]) => field !== "recordedAt"));
    const expectedHash = stateHash({ before: current ?? null, after: semanticResult });
    if (!apply) return c.json({ dryRun: true, expectedHash, diff });
    if (write.expectedHash !== expectedHash) throw new ConflictError("The event result changed after preview. Preview again before applying.");
    await repo.putResultIdempotent(
      result,
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason: write.reason },
      token.tokenId,
      key,
      write.bodyHash,
    );
    const readback = await repo.getResult(event.eventId, session.id);
    if (!readback || canonicalJson(readback) !== canonicalJson(result)) {
      throw new ConflictError("Result was saved but exact readback did not match. Stop and inspect before retrying.");
    }
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, result: readback }, 201);
  });

  app.get("/agent/events/:id/phases/:phase/score-context", async (c) => {
    const { token, issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const phase = scorePhaseFor(event.kind, c.req.param("phase"));
    const accountList = await repo.listAccounts(event.alliance);
    const names = new Map(accountList.map((account) => [account.playerId, account.name]));
    const current = await repo.getEventPhaseScores(event.eventId, phase.key);
    const officer = issuerGroups.has("officer") || issuerGroups.has("owner");
    const visible = officer ? undefined : new Set(await repo.linkedAccounts(token.issuedBy));
    const rows = (current?.playerPoints ?? []).filter((row) => !visible || visible.has(row.playerId));
    return c.json({
      event: { eventId: event.eventId, title: event.title, kind: event.kind, startsAt: event.startsAt },
      phase,
      version: current?.version ?? 0,
      coverage: current?.coverage ?? null,
      scoredPlayers: rows.length,
      reportedPlayerSubtotal: scoreSubtotal(rows),
      scores: rows.map((row, index) => ({ ...row, rank: index + 1, name: names.get(row.playerId) ?? row.playerId })),
      ...(officer ? { players: accountList.map(({ playerId, name }) => ({ playerId, name })) } : {}),
    });
  });

  app.put("/agent/events/:id/phases/:phase/scores", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "results:write", now(), botIssuerGroups);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const phase = scorePhaseFor(event.kind, c.req.param("phase"));
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const approved = body.approved === true;
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason || !expectedHash || !approved) throw new ValidationError("Applying phase scores requires the reviewed preview hash, explicit approval and a reason.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      const replay = await repo.getIdempotentChange(token.tokenId, key);
      if (replay) return replayAgentChange(c, replay, bodyHash, "result");
    }
    const input = parsePhaseScoreUpsert(body);
    const current = await repo.getEventPhaseScores(event.eventId, phase.key);
    if (input.expectedVersion !== (current?.version ?? 0)) throw new ConflictError("The phase scores changed. Fetch context and preview again.");
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const unresolved = input.playerPoints.filter((row) => !known.has(row.playerId)).map((row) => ({ playerId: row.playerId, reason: "Game account not found" }));
    if (unresolved.length > 0) throw new ValidationError("Some score rows cannot be applied.", { unresolved });
    const desired = upsertPhaseScores(current, input, {
      eventId: event.eventId,
      phaseKey: phase.key,
      phaseLabel: phase.label,
      recordedAt: now().toISOString(),
      recordedBy: `agent:${token.tokenId}`,
    });
    const previewHash = stateHash({
      beforeVersion: current?.version ?? 0,
      after: {
        eventId: desired.eventId,
        phaseKey: desired.phaseKey,
        phaseLabel: desired.phaseLabel,
        version: desired.version,
        coverage: desired.coverage,
        playerPoints: desired.playerPoints,
        source: desired.source,
      },
    });
    const result = {
      event: { eventId: event.eventId, title: event.title, kind: event.kind },
      phase,
      version: desired.version,
      coverage: desired.coverage,
      counts: phaseScoreCounts(current?.playerPoints ?? [], desired.playerPoints),
      subtotals: { before: scoreSubtotal(current?.playerPoints ?? []), after: scoreSubtotal(desired.playerPoints) },
      diff: { before: current?.playerPoints ?? [], after: desired.playerPoints },
      record: desired,
    };
    if (!apply) return c.json({ dryRun: true, expectedHash: previewHash, ...result });
    if (expectedHash !== previewHash) throw new ConflictError("This is not the exact reviewed preview. Preview again before applying.");
    await repo.putEventPhaseScoresIdempotent(desired, agentActor(token.tokenId, reason), token.tokenId, key, bodyHash, result);
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, result }, current ? 200 : 201);
  });

  // Everything below requires a verified token.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) throw new UnauthorizedError();
    let principal: Principal;
    let linked: Set<string>;
    if (match[1].startsWith("s26_")) {
      if (c.req.method !== "GET") throw new ForbiddenError("Bot tokens cannot use normal write routes.");
      const authenticated = await authenticateAgent(repo, header, c.req.header("origin"), "all:read", now(), botIssuerGroups);
      linked = new Set(await repo.linkedAccounts(authenticated.token.issuedBy));
      principal = { sub: authenticated.token.issuedBy, groups: authenticated.issuerGroups, linkedAccounts: linked };
    } else {
      const token = await verifier(match[1]);
      linked = new Set(await repo.linkedAccounts(token.sub));
      principal = { sub: token.sub, groups: await groupsFor(token.groups, linked), linkedAccounts: linked };
    }
    if (linked.size > 0) {
      const accounts = await Promise.all([...linked].map((id) => repo.getAccount(id)));
      if (!accounts.some((account) => account && ["active", "guest", "unknown"].includes(account.status))) {
        throw new ForbiddenError("Your POP HQ access is disabled because you are no longer an active alliance member.");
      }
    }
    const acting = resolveActingAccount(c.req.header("x-account-id"), linked);
    if (acting) principal.actingAs = acting;
    c.set("principal", principal);
    await next();
  });

  app.get("/me", async (c) => {
    const p = c.get("principal");
    const accounts = await Promise.all([...p.linkedAccounts].map((id) => repo.getAccount(id)));
    return c.json({
      sub: p.sub,
      groups: [...p.groups],
      actingAs: p.actingAs ?? null,
      accounts: accounts.filter((a) => a !== undefined),
    });
  });

  /** Officers issue narrow bot credentials; the secret is returned exactly once. */
  app.post("/agent-tokens", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const active = (await repo.listAgentTokens(p.sub)).filter((token) => !token.revokedAt && Date.parse(token.expiresAt) > now().getTime());
    if (active.length >= 5) throw new ConflictError("You already have five active bot tokens. Revoke one first.");
    const issued = issueAgentToken(await readJson(c.req.raw), p.sub, now());
    if (issued.record.scopes.includes("rewards:write") || issued.record.scopes.includes("accounts:write")) {
      await requireBotIssuerR4(p.sub);
    }
    await repo.createAgentToken(issued.record);
    return c.json({ ...publicAgentToken(issued.record), token: issued.token }, 201);
  });

  app.get("/agent-tokens", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const records = await repo.listAgentTokens(p.groups.has("owner") ? undefined : p.sub);
    return c.json({ items: records.map(publicAgentToken) });
  });

  app.delete("/agent-tokens/:tokenId", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    await repo.revokeAgentToken(c.req.param("tokenId"), p.sub, now());
    return c.json({ revoked: true });
  });

  app.get("/accounts", async (c) => {
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    return c.json({ items: await repo.listAccounts(alliance) });
  });

  app.post("/accounts", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const account = parseNewAccount(await readJson(c.req.raw));
    await repo.createAccount(account, { id: p.sub, via: "web" });
    return c.json(account, 201);
  });

  /** Officers keep the roster right: rank, status, name, alliance and a note (ROS-01..05). */
  app.patch("/accounts/:pid", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(pid);
    if (!account) throw new NotFoundError("Game account not found.");
    const updated = parseAccountChanges(account, await readJson(c.req.raw));
    if (updated.status !== account.status && (updated.status === "transferred_out" || account.status === "transferred_out")) {
      throw new ValidationError("Use the member profile to mark the whole person as left or welcome them back.");
    }
    await repo.updateAccount(updated, { id: p.sub, via: "web", reason: "roster edit" });
    return c.json(updated);
  });

  app.get("/accounts/:pid", async (c) => {
    const account = await repo.getAccount(parsePlayerId(c.req.param("pid")));
    if (!account) throw new NotFoundError("Game account not found.");
    return c.json(account);
  });

  app.post("/accounts/:pid/links", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { sub?: unknown };
    if (typeof body.sub !== "string" || body.sub.length === 0) throw new ValidationError("sub is required.");
    await repo.linkAccount(body.sub, pid, { id: p.sub, via: "web", reason: "verified by officer" });
    return c.json({ sub: body.sub, playerId: pid }, 201);
  });

  const identityView = async (playerId: string) => {
    const anchor = await repo.getAccount(playerId);
    if (!anchor) throw new NotFoundError("Game account not found.");
    const identityGroup = await repo.identityGroup(playerId);
    const sub = await repo.linkedLogin(playerId);
    const ids = identityGroup?.playerIds ?? (sub ? await repo.linkedAccounts(sub) : [playerId]);
    const accounts = (await Promise.all(ids.map(async (id) => {
      const [account, aliases] = await Promise.all([repo.getAccount(id), repo.listAliases(id)]);
      return account ? { ...account, aliases } : undefined;
    }))).filter((account): account is NonNullable<typeof account> => Boolean(account));
    const explicitPrimary = sub ? await repo.primaryAccount(sub) : undefined;
    const primaryPlayerId = identityGroup?.primaryPlayerId ?? (explicitPrimary && ids.includes(explicitPrimary) ? explicitPrimary : ids[0] ?? playerId);
    const audit = (await Promise.all(ids.map((id) => repo.listIdentityAudit(id))))
      .flat().toSorted((a, b) => b.performedAt.localeCompare(a.performedAt));
    return { primaryPlayerId, accounts: accounts.map((account) => ({ ...account, isPrimary: account.playerId === primaryPlayerId })), audit };
  };

  app.get("/accounts/:pid/identity", async (c) => {
    await requireR4(c.get("principal"));
    return c.json(await identityView(parsePlayerId(c.req.param("pid"))));
  });

  /** Reversibly remove or restore a person, including every linked secondary account and login. */
  app.put("/accounts/:pid/membership", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const anchorPlayerId = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { active?: unknown; justification?: unknown; effectiveDate?: unknown };
    if (typeof body.active !== "boolean") throw new ValidationError("Choose whether this person is an active member.");
    const justification = parseIdentityJustification(body.justification);
    const effectiveAt = body.effectiveDate === undefined ? now().toISOString() : parseMembershipEffectiveDate(body.effectiveDate, now());
    const [group, sub] = await Promise.all([repo.identityGroup(anchorPlayerId), repo.linkedLogin(anchorPlayerId)]);
    const playerIds = group?.playerIds ?? (sub ? await repo.linkedAccounts(sub) : [anchorPlayerId]);
    const accounts = await Promise.all(playerIds.map((id) => repo.getAccount(id)));
    if (accounts.some((account) => !account)) throw new NotFoundError("One of the linked game accounts no longer exists.");
    const targetStatus = body.active ? "active" : "transferred_out";
    if (accounts.every((account) => account?.status === targetStatus)) {
      throw new ConflictError(body.active ? "This person is already an active member." : "This person has already left the alliance.");
    }
    if (sub && !logins) throw new ConflictError("Login management is not available.");
    const priorChanges = membershipChanges(await membershipAuditFor(accounts.filter((account): account is GameAccount => Boolean(account))));
    const prior = priorChanges.at(-1);
    if (prior && effectiveAt < prior.effectiveAt) {
      throw new ValidationError(`The effective date cannot be before the previous membership change on ${prior.effectiveAt.slice(0, 10)}.`);
    }

    // Change Cognito first. Existing tokens still cannot write after the atomic status change;
    // on a database conflict the compensating call restores the previous login state.
    if (sub) {
      if (body.active) await logins!.enableLogin(sub);
      else await logins!.disableLogin(sub);
    }
    try {
      await repo.setPersonMembership(
        group?.primaryPlayerId ?? anchorPlayerId,
        playerIds,
        body.active,
        justification,
        { id: p.sub, via: "web", reason: body.active ? "member welcomed back" : "member left alliance" },
        officer.name,
        effectiveAt,
      );
    } catch (error) {
      if (sub) {
        if (body.active) await logins!.disableLogin(sub).catch(() => undefined);
        else await logins!.enableLogin(sub).catch(() => undefined);
      }
      throw error;
    }
    return c.json(await identityView(anchorPlayerId));
  });

  /** Correct a former member's departure boundary while preserving the original audit record. */
  app.put("/accounts/:pid/membership/effective-date", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const anchorPlayerId = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { effectiveDate?: unknown; justification?: unknown };
    const effectiveAt = parseMembershipEffectiveDate(body.effectiveDate, now());
    const justification = parseIdentityJustification(body.justification);
    const [group, sub] = await Promise.all([repo.identityGroup(anchorPlayerId), repo.linkedLogin(anchorPlayerId)]);
    const playerIds = group?.playerIds ?? (sub ? await repo.linkedAccounts(sub) : [anchorPlayerId]);
    const accounts = (await Promise.all(playerIds.map((id) => repo.getAccount(id)))).filter((account): account is GameAccount => Boolean(account));
    if (accounts.length !== playerIds.length) throw new NotFoundError("One of the linked game accounts no longer exists.");
    if (accounts.some((account) => account.status !== "transferred_out")) {
      throw new ConflictError("Departure dates can only be edited for former members.");
    }
    const audits = await membershipAuditFor(accounts);
    const rawChanges = audits
      .filter((audit) => audit.action === "membership_left" || audit.action === "membership_restored")
      .filter((audit, index, all) => all.findIndex((item) => item.auditId === audit.auditId) === index)
      .toSorted((a, b) => a.performedAt.localeCompare(b.performedAt));
    const target = rawChanges.at(-1);
    if (target && target.action !== "membership_left") throw new ConflictError("The latest membership record is not a departure.");
    if (target) {
      const resolved = membershipChanges(audits);
      const targetIndex = resolved.findIndex((change) => change.auditId === target.auditId);
      const previous = targetIndex > 0 ? resolved[targetIndex - 1] : undefined;
      if (previous && effectiveAt < previous.effectiveAt) {
        throw new ValidationError(`The departure date cannot be before the previous return on ${previous.effectiveAt.slice(0, 10)}.`);
      }
      const resolvedTarget = resolved.find((change) => change.auditId === target.auditId);
      await repo.recordMembershipBoundary(
        group?.primaryPlayerId ?? anchorPlayerId,
        playerIds,
        effectiveAt,
        justification,
        { id: p.sub, via: "web", reason: "former-member departure date corrected" },
        officer.name,
        resolvedTarget ?? target,
      );
    } else {
      await repo.recordMembershipBoundary(
        group?.primaryPlayerId ?? anchorPlayerId,
        playerIds,
        effectiveAt,
        justification,
        { id: p.sub, via: "web", reason: "legacy former-member departure date recorded" },
        officer.name,
      );
    }
    return c.json(await identityView(anchorPlayerId));
  });

  app.post("/accounts/:pid/identity/accounts", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const anchorPlayerId = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { secondaryPlayerId?: unknown; justification?: unknown };
    const secondaryPlayerId = parsePlayerId(body.secondaryPlayerId);
    if (secondaryPlayerId === anchorPlayerId) throw new ValidationError("Choose a different account to link.");
    await repo.linkSecondaryAccount(anchorPlayerId, secondaryPlayerId, parseIdentityJustification(body.justification), { id: p.sub, via: "web" }, officer.name);
    return c.json(await identityView(anchorPlayerId), 201);
  });

  app.put("/accounts/:pid/identity/main", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const anchorPlayerId = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { playerId?: unknown; justification?: unknown };
    await repo.setPrimaryAccount(anchorPlayerId, parsePlayerId(body.playerId), parseIdentityJustification(body.justification), { id: p.sub, via: "web" }, officer.name);
    return c.json(await identityView(anchorPlayerId));
  });

  app.delete("/accounts/:pid/identity/accounts/:secondaryPid", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const anchorPlayerId = parsePlayerId(c.req.param("pid"));
    const secondaryPlayerId = parsePlayerId(c.req.param("secondaryPid"));
    if (secondaryPlayerId === anchorPlayerId) throw new ValidationError("Open another linked account before unlinking this one.");
    const body = (await readJson(c.req.raw)) as { justification?: unknown };
    await repo.unlinkSecondaryAccount(anchorPlayerId, secondaryPlayerId, parseIdentityJustification(body.justification), { id: p.sub, via: "web" }, officer.name);
    return c.json(await identityView(anchorPlayerId));
  });

  app.post("/accounts/:pid/aliases", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const playerId = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { name?: unknown; justification?: unknown };
    await repo.addAlias(playerId, parseGameName(body.name), parseIdentityJustification(body.justification), { id: p.sub, via: "web" }, officer.name);
    return c.json(await identityView(playerId), 201);
  });

  app.get("/accounts/:pid/reports", async (c) => {
    const pid = parsePlayerId(c.req.param("pid"));
    const reports = await repo.listReports(pid);
    return c.json({ items: reports, current: currentValues(reports) });
  });

  /** Officer roster: every account with its latest and previous city power (ROS-01). */
  app.get("/roster", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    const [accounts, accountEvidence] = await Promise.all([
      repo.listAccounts(alliance),
      repo.listHistoricalRecords("evidence"),
    ]);
    // One query per account is fine at alliance size (~100); a summary item replaces this later.
    const participationFrom = new Date(at.getTime() - PARTICIPATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const pastEvents = await repo.listEvents(alliance, participationFrom, 100);
    const scores = await resultEvidence(pastEvents);
    const people = await attendancePeople(accounts);
    const personParticipation = new Map<string, {
      attendance: ReturnType<typeof participationOf>;
      attendanceTrend: (number | null)[];
      membershipLeftAt: string | null;
    }>();
    await Promise.all(people.map(async (personAccounts) => {
      const [rawAnswers, rawAttendance] = await Promise.all([
        Promise.all(personAccounts.map((account) => repo.answersForAccount(account.playerId, participationFrom))).then((items) => items.flat()),
        Promise.all(personAccounts.map((account) => repo.attendanceFor(account.playerId))).then((items) => items.flat()),
      ]);
      const answers = personAnswers(rawAnswers);
      const attendance = personAttendance(rawAttendance);
      const scoreEvidence = new Set(personAccounts.flatMap((account) => [...(scores.byPlayer.get(account.playerId) ?? [])]));
      const noShowEvidence = new Set(personAccounts.flatMap((account) => [...(scores.noShowByPlayer.get(account.playerId) ?? [])]));
      const knownSince = personAccounts.map((account) => account.createdAt).filter((value): value is string => Boolean(value)).toSorted()[0];
      const membership = await membershipContextFor(personAccounts);
      const periods = membership.periods;
      const changes = membershipChanges(membership.audits);
      const latestChange = changes.at(-1);
      const eventStarts = new Map(pastEvents.map((event) => [event.eventId, event.startsAt]));
      const eligibleAttendance = attendance.filter((record) => {
        const startsAt = eventStarts.get(record.eventId);
        return startsAt === undefined || wasMemberAt(periods, startsAt);
      });
      const combined = participationOf({
        events: pastEvents,
        answers,
        attendance: eligibleAttendance,
        scoreEvidence: [...scoreEvidence],
        noShowEvidence: [...noShowEvidence],
        completeEvidence: [...scores.completeEvents],
        now: at,
        ...(knownSince ? { knownSince } : {}),
        membershipPeriods: periods,
      });
      const explained = explainPersonParticipation(combined, pastEvents, personAccounts, answers, eligibleAttendance, scores);
      const shared = {
        attendance: explained,
        attendanceTrend: trailingAverage(monthlyAttendance(eligibleAttendance, at)),
        membershipLeftAt: latestChange?.action === "membership_left" ? latestChange.effectiveAt : null,
      };
      for (const account of personAccounts) personParticipation.set(account.playerId, shared);
    }));
    const items = await Promise.all(
      accounts.map(async (account) => {
        const [reports, linkedAccess, aliases] = await Promise.all([
          repo.listReports(account.playerId),
          repo.linkedLoginAccess(account.playerId),
          repo.listAliases(account.playerId),
        ]);
        const series = activeReports(reports)
          .flatMap((r) => {
            const v = r.values.find((x) => x.metric === "city_power")?.value;
            return typeof v === "number" ? [{ at: r.effectiveAt, power: v }] : [];
          })
          .toSorted((a, b) => a.at.localeCompare(b.at));
        const cur = currentValues(reports);
        const participation = personParticipation.get(account.playerId)!;
        const foundrySeries = seriesOf(reports, "foundry_strength");
        return {
          ...account,
          aliases: aliases.map((alias) => alias.name),
          hasLogin: linkedAccess !== undefined,
          loginMethod: linkedAccess?.loginMethod ?? null,
          loginName: linkedAccess?.loginMethod === "password" && linkedAccess.loginIdentifier
            ? linkedAccess.loginIdentifier.replace(/@members\.pophq\.invalid$/i, "")
            : null,
          // Six trailing months for the small graphs in the table (MET-02).
          powerTrend: monthlyValues(
            series.map((p) => ({ at: p.at, value: p.power })),
            at,
          ),
          strengthTrend: monthlyValues(foundrySeries, at),
          // Trailing three-month average, so one bad night does not look like a collapse.
          attendanceTrend: participation.attendanceTrend,
          power: series.at(-1)?.power ?? null,
          previousPower: series.at(-2)?.power ?? null,
          foundryStrength: foundrySeries.at(-1)?.value ?? null,
          attendance: participation.attendance,
          membershipLeftAt: participation.membershipLeftAt,
          lastFoundryReportAt: foundrySeries.at(-1)?.at ?? null,
          lastReportAt: series.at(-1)?.at ?? null,
          furnace: cur.furnace_level?.value ?? null,
          reports: reports.length,
        };
      }),
    );
    const unresolvedSources = accountEvidence
      .filter((record) => record.reviewStatus === "unresolved" && !record.playerId)
      .map((record) => {
        const payload = typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)
          ? record.payload as Record<string, unknown>
          : {};
        return {
          recordId: record.recordId,
          sourceId: record.sourceId,
          suppliedName: typeof payload.suppliedName === "string" ? payload.suppliedName : "Unknown account",
          eventId: record.eventId ?? null,
          reviewStatus: record.reviewStatus,
        };
      });
    return c.json({ items, seats: await repo.seats(), unresolvedSources });
  });

  /**
   * Invites someone: creates either an emailed-code login or a one-time password login, then
   * creates/links the game account (P4.1). Repeating the same invite changes nothing.
   */
  if (logins) {
    app.post("/onboarding-invitations", async (c) => {
      const p = c.get("principal");
      requireOfficer(p);
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const playerId = parsePlayerId(body.playerId);
      if (!(await repo.getAccount(playerId))) {
        await invite(
          { repo, logins, actor: { id: p.sub, via: "web", reason: "account created for one-time onboarding invitation" } },
          {
            loginMethod: "none",
            playerId,
            name: String(body.name ?? ""),
            ...(typeof body.rank === "string" ? { rank: body.rank } : {}),
          },
        );
      }
      const result = await issueOnboardingInvite(
        repo,
        playerId,
        { id: p.sub, via: "web", reason: "24-hour one-time onboarding invitation issued" },
        now(),
      );
      c.header("Cache-Control", "no-store");
      return c.json({
        token: result.token,
        inviteId: result.invitation.inviteId,
        playerId: result.invitation.playerId,
        playerName: result.invitation.playerName,
        expiresAt: result.invitation.expiresAt,
      }, 201);
    });

    app.post("/accounts/:pid/recovery-invitations", async (c) => {
      const p = c.get("principal");
      requireOfficer(p);
      const playerId = parsePlayerId(c.req.param("pid"));
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const result = await issuePasswordRecoveryInvite(
        repo,
        playerId,
        parseResetJustification(body.justification),
        { id: p.sub, via: "web", reason: "24-hour one-time password recovery invitation issued" },
        now(),
      );
      c.header("Cache-Control", "no-store");
      return c.json({
        token: result.token,
        inviteId: result.invitation.inviteId,
        playerId: result.invitation.playerId,
        playerName: result.invitation.playerName,
        expiresAt: result.invitation.expiresAt,
        purpose: "password_recovery",
      }, 201);
    });

    app.post("/invites", async (c) => {
      const p = c.get("principal");
      requireOfficer(p);
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      if (body.loginMethod !== undefined && !["email", "password", "none"].includes(String(body.loginMethod))) {
        throw new ValidationError("Choose email-code or password access.");
      }
      const result = await invite(
        { repo, logins, actor: { id: p.sub, via: "web", reason: "invite" } },
        {
          ...(typeof body.email === "string" ? { email: body.email } : {}),
          ...(body.loginMethod === "email" || body.loginMethod === "password" || body.loginMethod === "none"
            ? { loginMethod: body.loginMethod }
            : {}),
          playerId: String(body.playerId ?? ""),
          name: String(body.name ?? ""),
          ...(typeof body.rank === "string" ? { rank: body.rank } : {}),
          ...(typeof body.alliance === "string" ? { alliance: body.alliance } : {}),
        },
      );
      // Password credentials exist only in this response. Do not let a browser or intermediary
      // reuse a cached copy after the officer closes the one-time credential screen.
      c.header("Cache-Control", "no-store");
      return c.json(result, result.accountCreated || result.linked || result.loginCreated ? 201 : 200);
    });

    app.post("/accounts/:pid/password-reset", async (c) => {
      const p = c.get("principal");
      requireOfficer(p);
      const playerId = parsePlayerId(c.req.param("pid"));
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const result = await resetMemberPassword(
        { repo, logins, actor: { id: p.sub, via: "web", reason: "password recovery" } },
        playerId,
        parseResetJustification(body.justification),
      );
      c.header("Cache-Control", "no-store");
      return c.json(result, 201);
    });

    app.get("/accounts/:pid/access-audit", async (c) => {
      requireOfficer(c.get("principal"));
      const playerId = parsePlayerId(c.req.param("pid"));
      if (!(await repo.getAccount(playerId))) throw new NotFoundError(`Game account ${playerId} not found.`);
      return c.json({
        items: await repo.listAccessAudit(playerId),
        invitations: await repo.listOnboardingInviteAudit(playerId),
      });
    });
  }

  /**
   * What changed for a game account and when (DATA-02). Members see their own accounts;
   * officers see everyone (decision: who sees what, docs/PLAN.md).
   */
  if (history) {
    app.get("/accounts/:pid/timeline", async (c) => {
      const p = c.get("principal");
      const pid = parsePlayerId(c.req.param("pid"));
      if (!p.linkedAccounts.has(pid)) requireOfficer(p);
      if (!(await repo.getAccount(pid))) throw new NotFoundError(`Game account ${pid} not found.`);
      const limit = Number(c.req.query("limit") ?? 50);
      const before = c.req.query("before");
      const page = await history.timeline(`ACCOUNT#${pid}`, Number.isFinite(limit) ? limit : 50, before);
      return c.json(page);
    });
  }

  /**
   * Alliance growth for the officer charts (MET-01): totals over time, who grew, who stalled
   * and who never reported. Officer-only, like the roster.
   */
  app.get("/metrics/alliance", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const metric = c.req.query("metric") === "foundry_strength" ? "foundry_strength" : "city_power";
    const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 12) || 12, 2), 52);
    // Cohort: confirmed members and guests by default. Accounts whose membership is unknown
    // (imported history) would inflate the totals, so they are counted separately and only
    // included on request.
    const cohort = c.req.query("cohort") === "all" ? "all" : "members";
    const all = await repo.listAccounts(alliance);
    const counted = all.filter((a) => a.status === "active" || a.status === "guest");
    const unknown = all.filter((a) => a.status === "unknown");
    const accounts = cohort === "all" ? [...counted, ...unknown] : counted;
    const people = await attendancePeople(accounts);
    const periodsByPlayer = new Map<string, MembershipPeriod[]>();
    await Promise.all(people.map(async (group) => {
      const periods = await membershipPeriodsFor(group);
      for (const account of group) periodsByPlayer.set(account.playerId, periods);
    }));
    const series = await Promise.all(
      accounts.map(async (account) => ({
        playerId: account.playerId,
        name: account.name,
        points: seriesOf(await repo.listReports(account.playerId), metric),
        membershipPeriods: periodsByPlayer.get(account.playerId) ?? [],
      })),
    );
    return c.json({
      ...allianceGrowth(metric, series, buckets(now(), weeks)),
      weeks,
      alliance,
      cohort,
      unknownMembership: unknown.length,
    });
  });

  /** Alliance-wide weekly attendance for the R4/R5 members view. */
  app.get("/metrics/alliance-attendance", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 12) || 12, 2), 52);
    const windowStart = new Date(now().getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = (await repo.listEvents(alliance, windowStart, 500)).filter(
      (event) => Date.parse(event.startsAt) <= now().getTime(),
    );
    const accounts = (await repo.listAccounts(alliance)).filter(
      (account) => account.status === "active" || account.status === "unknown",
    );
    const people = await attendancePeople(accounts);
    const periods = await Promise.all(people.map((group) => membershipPeriodsFor(group)));
    const scores = await resultEvidence(events);
    const eventData = await Promise.all(events.map(async (event) => ({
      event,
      attendance: await repo.listAttendance(event.eventId),
      scored: scores.byEvent.get(event.eventId) ?? new Set<string>(),
      noShows: scores.noShowByEvent.get(event.eventId) ?? new Set<string>(),
    })));
    const reviewed = groupAttendanceOccurrences(eventData).filter(attendanceOccurrenceHasEvidence);
    const samples = reviewed.map((occurrence) => {
      const latest = occurrence.map((item) => item.event).toSorted((a, b) => b.startsAt.localeCompare(a.startsAt))[0]!;
      const coverage = attendanceOccurrenceCoverage(occurrence, scores.completeEvents);
      const statuses = people.flatMap((group, index) => {
        if (!wasMemberAt(periods[index] ?? [], latest.startsAt)) return [];
        const status = attendanceStatusForOccurrence(occurrence, new Set(group.map((account) => account.playerId)));
        // Partial global leaderboards can prove a named score or no-show, but cannot prove that
        // an unlisted alliance member was absent.
        return status === undefined && coverage === "partial" ? [] : [status];
      });
      return {
        eventId: latest.eventId,
        at: latest.startsAt,
        present: statuses.filter((status) => status === "present").length,
        absent: statuses.filter((status) => status === "absent" || status === undefined).length,
      };
    });
    const coverage = {
      complete: reviewed.filter((occurrence) => attendanceOccurrenceCoverage(occurrence, scores.completeEvents) === "complete").length,
      partial: reviewed.filter((occurrence) => attendanceOccurrenceCoverage(occurrence, scores.completeEvents) === "partial").length,
    };
    return c.json({ alliance, weeks, coverage, points: allianceAttendance(samples, buckets(now(), weeks)) });
  });

  /** Per-event-type participation: who turns up consistently, sometimes, or never. */
  app.get("/metrics/event-participation", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const requestedKind = c.req.query("kind") ?? "foundry";
    const kind = EVENT_KINDS.includes(requestedKind as EventKind) ? (requestedKind as EventKind) : "foundry";
    const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 12) || 12, 2), 52);
    const windowStart = new Date(now().getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = (await repo.listEvents(alliance, windowStart, 500))
      .filter((event) => event.kind === kind && Date.parse(event.startsAt) <= now().getTime())
      .toSorted((a, b) => a.startsAt.localeCompare(b.startsAt));
    const scores = await resultEvidence(events);
    const eventData = await Promise.all(events.map(async (event) => ({
      event,
      attendance: await repo.listAttendance(event.eventId),
      scored: scores.byEvent.get(event.eventId) ?? new Set<string>(),
      noShows: scores.noShowByEvent.get(event.eventId) ?? new Set<string>(),
    })));
    // A partially reviewed event can count explicit evidence, but never silent absences.
    const tracked = groupAttendanceOccurrences(eventData).filter(attendanceOccurrenceHasEvidence);
    const accounts = (await repo.listAccounts(alliance)).filter(
      (account) => account.status === "active" || account.status === "unknown",
    );
    const people = await attendancePeople(accounts);
    const periods = await Promise.all(people.map((group) => membershipPeriodsFor(group)));
    const members = people.map((group, personIndex) => {
      const account = group[0]!;
      const ids = new Set(group.map((item) => item.playerId));
      let attended = 0;
      let considered = 0;
      let lastAttendedAt: string | undefined;
      for (const occurrence of tracked) {
        const event = occurrence.map((item) => item.event).toSorted((a, b) => b.startsAt.localeCompare(a.startsAt))[0]!;
        if (!wasMemberAt(periods[personIndex] ?? [], event.startsAt)) continue;
        const coverage = attendanceOccurrenceCoverage(occurrence, scores.completeEvents);
        const status = attendanceStatusForOccurrence(occurrence, ids);
        if (status === "excused") continue;
        if (status === undefined && coverage === "partial") continue;
        considered += 1;
        if (status === "present") {
          attended += 1;
          lastAttendedAt = event.startsAt;
        }
      }
      const rate = considered > 0 ? attended / considered : undefined;
      const category = rate === undefined ? "no_history" : rate === 1 ? "always" : rate === 0 ? "never" : "sometimes";
      return {
        playerId: account.playerId,
        name: account.name,
        rank: account.rank,
        linkedAccounts: group.slice(1).map((item) => ({ playerId: item.playerId, name: item.name })),
        attended,
        events: considered,
        ...(rate === undefined ? {} : { rate }),
        category,
        ...(lastAttendedAt ? { lastAttendedAt } : {}),
      };
    });
    const samples = tracked.map((occurrence) => {
      const event = occurrence.map((item) => item.event).toSorted((a, b) => b.startsAt.localeCompare(a.startsAt))[0]!;
      const coverage = attendanceOccurrenceCoverage(occurrence, scores.completeEvents);
      const statuses = people.flatMap((group, index) => {
        if (!wasMemberAt(periods[index] ?? [], event.startsAt)) return [];
        const status = attendanceStatusForOccurrence(occurrence, new Set(group.map((account) => account.playerId)));
        return status === undefined && coverage === "partial" ? [] : [status];
      });
      return {
        eventId: event.eventId,
        at: event.startsAt,
        present: statuses.filter((status) => status === "present").length,
        absent: statuses.filter((status) => status === "absent" || status === undefined).length,
      };
    });
    const coverage = {
      complete: tracked.filter((occurrence) => attendanceOccurrenceCoverage(occurrence, scores.completeEvents) === "complete").length,
      partial: tracked.filter((occurrence) => attendanceOccurrenceCoverage(occurrence, scores.completeEvents) === "partial").length,
    };
    return c.json({
      alliance,
      kind,
      weeks,
      eventCount: tracked.length,
      coverage,
      points: allianceAttendance(samples, buckets(now(), weeks)),
      members,
    });
  });

  // ---- Event types (EVT-01) ----

  /** The types events can be created from. Everyone may read them; officers may change them. */
  app.get("/event-types", async (c) => {
    const p = c.get("principal");
    const types = await listEventTypes(repo, { id: p.sub, via: "web" });
    return c.json({ items: types.filter((t) => !t.archived), archived: types.filter((t) => t.archived) });
  });

  app.post("/event-types", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const type = parseEventType(await readJson(c.req.raw), p.sub);
    if (await repo.getEventType(type.typeId)) throw new ConflictError(`An event type "${type.typeId}" already exists.`);
    await repo.putEventType(type, { id: p.sub, via: "web", reason: "new event type" });
    return c.json(type, 201);
  });

  app.patch("/event-types/:typeId", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const existing = await repo.getEventType(c.req.param("typeId"));
    if (!existing) throw new NotFoundError("Event type not found.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const updated = parseEventType({ ...existing, ...body, typeId: existing.typeId }, existing.createdBy);
    await repo.putEventType(updated, { id: p.sub, via: "web", reason: "event type changed" });
    return c.json(updated);
  });

  // ---- Events (EVT-01..EVT-04) ----

  /** Officers schedule an event; answers close at the deadline. */
  app.post("/events", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = parseNewEvent(await readJson(c.req.raw), {
      eventId: ulid(),
      createdBy: p.sub,
      now: now(),
    });
    await repo.createEvent(event, { id: p.sub, via: "web" });
    // The type's checklist becomes this event's own, so editing one event's jobs never disturbs
    // the template or another event.
    const tasks = (await repo.getEventType(event.kind))?.checklist ?? STARTER_CHECKLISTS[event.kind] ?? [];
    if (tasks.length > 0) {
      await repo.putChecklist(
        { eventId: event.eventId, version: 1, entries: tasks.map((t) => ({ ...t })), updatedAt: now().toISOString() },
        { id: p.sub, via: "web", reason: "checklist from the event type" },
      );
    }
    return c.json(event, 201);
  });

  /**
   * An officer ticks a job off, or takes the tick back. Any officer may: jobs still have to get
   * done when the owner is asleep, and the tick records who did it.
   */
  app.put("/events/:id/checklist/:taskId", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const current = await repo.getChecklist(event.eventId);
    if (!current) throw new NotFoundError("This event has no checklist.");
    const body = (await readJson(c.req.raw)) as { done?: unknown };
    const acting = defaultActing(p);
    if (!acting) throw new ForbiddenError("Link a game account before ticking jobs off.");
    const entries = applyTick(current, c.req.param("taskId"), body.done !== false, { playerId: acting, now: now() });
    const updated = { ...current, version: current.version + 1, entries, updatedAt: now().toISOString() };
    await repo.putChecklist(updated, { id: p.sub, via: "web", reason: "checklist tick" });
    return c.json({ ...updated, tasks: datedTasks(event, entries, now()) });
  });

  /**
   * What officers still have to do. Only jobs that can still be done: an "overdue" job missed its
   * chance when the battle started, and nagging about it is noise — the event page keeps it. The
   * reader's own events come first, then the oldest job.
   */
  app.get("/officer-jobs", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const at = now();
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const events = await repo.listEvents(alliance, new Date(at.getTime() - PAST_EVENTS_MS).toISOString());
    const accounts = new Map((await repo.listAccounts(alliance)).map((a) => [a.playerId, a.name]));
    const jobs = (
      await Promise.all(
        events.map(async (event) => {
          const checklist = await repo.getChecklist(event.eventId);
          if (!checklist) return [];
          return datedTasks(event, checklist.entries, at)
            .filter((task) => task.state === "due")
            .map((task) => ({
              eventId: event.eventId,
              eventTitle: event.title,
              startsAt: event.startsAt,
              ownerPlayerId: event.ownerPlayerId ?? null,
              ownerName: event.ownerPlayerId ? (accounts.get(event.ownerPlayerId) ?? null) : null,
              mine: event.ownerPlayerId !== undefined && p.linkedAccounts.has(event.ownerPlayerId),
              taskId: task.id,
              label: task.label,
              dueAt: task.dueAt,
            }));
        }),
      )
    ).flat();
    // Yours first, then the most overdue.
    jobs.sort((a, b) => Number(b.mine) - Number(a.mine) || a.dueAt.localeCompare(b.dueAt));
    return c.json({ items: jobs });
  });

  /**
   * Officers record who actually turned up (EVT-07). One record per game account per event;
   * recording it again replaces the earlier record and keeps the old one in the history.
   */
  app.put("/events/:id/attendance/:pid", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const input = parseAttendance(await readJson(c.req.raw));
    if (input.sessionId && !event.sessions.some((s) => s.id === input.sessionId)) {
      throw new ValidationError("That part of the event doesn't exist.");
    }
    const saved = await repo.setAttendance(
      { ...input, eventId: event.eventId, playerId: pid, source: "officer" },
      { id: p.sub, via: "web", reason: "attendance" },
    );
    return c.json(saved);
  });

  /** A member's event participation, including attendance, no-shows and silence. */
  app.get("/accounts/:pid/reliability", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    if (!p.linkedAccounts.has(pid)) requireOfficer(p);
    const at = now();
    const from = new Date(at.getTime() - PARTICIPATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const account = await repo.getAccount(pid);
    const events = await repo.listEvents(account?.alliance ?? "POP", from, 100);
    const scores = await resultEvidence(events);
    const identityGroup = await repo.identityGroup(pid);
    const linkedSub = identityGroup ? undefined : await repo.linkedLogin(pid);
    const playerIds = identityGroup?.playerIds ?? (linkedSub ? await repo.linkedAccounts(linkedSub) : [pid]);
    const personAccounts = (await Promise.all(playerIds.map((playerId) => repo.getAccount(playerId))))
      .filter((item): item is GameAccount => Boolean(item));
    const periods = await membershipPeriodsFor(personAccounts);
    return c.json(
      participationOf({
        events,
        answers: personAnswers((await Promise.all(playerIds.map((playerId) => repo.answersForAccount(playerId, from)))).flat()),
        attendance: personAttendance((await Promise.all(playerIds.map((playerId) => repo.attendanceFor(playerId)))).flat()),
        scoreEvidence: [...new Set(playerIds.flatMap((playerId) => [...(scores.byPlayer.get(playerId) ?? [])]))],
        noShowEvidence: [...new Set(playerIds.flatMap((playerId) => [...(scores.noShowByPlayer.get(playerId) ?? [])]))],
        completeEvidence: [...scores.completeEvents],
        now: at,
        ...(account?.createdAt ? { knownSince: account.createdAt } : {}),
        membershipPeriods: periods,
      }),
    );
  });

  // ---- SvS buff slots (BUF-01..BUF-06) ----

  /** Officers open a round: three buff days and the moment preferences close. */
  app.post("/svs-rounds", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const round = parseNewRound(await readJson(c.req.raw), { roundId: ulid(), createdBy: p.sub, now: now() });
    await repo.putRound(round, { id: p.sub, via: "web" });
    return c.json({ ...round, state: roundState(round, now()) }, 201);
  });

  /** Rounds that have not finished, earliest first, with whether you have answered. */
  app.get("/svs-rounds", async (c) => {
    const p = c.get("principal");
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    // A round stays listed until its last buff day is over.
    const from = new Date(at.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rounds = await repo.listRounds(alliance, from);
    const acting = defaultActing(p);
    const visibleRounds = isOfficer(p) ? rounds : rounds.filter((round) => round.bookingEnabled);
    const items = await Promise.all(
      visibleRounds.map(async (round) => {
        const bookings = await repo.listMinistryBookings(round.roundId);
        const mine = acting ? bookings.filter((booking) => booking.playerId === acting) : [];
        const nextBooking = mine
          .map((booking) => {
            const day = round.days.find((candidate) => candidate.id === booking.dayId);
            return day ? { ...booking, startsAt: slotStartsAt(day, booking.slot), buff: day.buff } : undefined;
          })
          .filter((booking): booking is NonNullable<typeof booking> => Boolean(booking))
          .filter((booking) => Date.parse(booking.startsAt) + 30 * 60 * 1000 > at.getTime())
          .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
        return {
          ...round,
          state: roundState(round, at),
          answered: acting ? (await repo.getPreferences(round.roundId, acting)) !== undefined || mine.length > 0 : false,
          term: ministryTerm(round),
          ...(nextBooking ? { nextBooking } : {}),
        };
      }),
    );
    return c.json({ items });
  });

  /**
   * One round: its days and slots, your own preferences, and how many people want each slot.
   * Demand is visible to everyone — it helps members pick a quiet hour, which is the point.
   */
  app.get("/svs-rounds/:id", async (c) => {
    const p = c.get("principal");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Round not found.");
    if (!round.bookingEnabled && !isOfficer(p)) throw new NotFoundError("Ministry booking is not open.");
    const at = now();
    const preferences = await repo.listPreferences(round.roundId);
    const bookings = await repo.listMinistryBookings(round.roundId);
    const acting = defaultActing(p);

    const days = round.days.map((day) => {
      const answers = preferences.flatMap((pref) => pref.days.filter((d) => d.dayId === day.id));
      const demand = Array.from({ length: SLOTS_PER_DAY }, (_, slot) => answers.filter((a) => a.slots.includes(slot)).length);
      return {
        ...day,
        startsAt: slotStartsAt(day, 0),
        endsAt: dayEndsAt(day),
        demand,
        anyTime: answers.filter((a) => a.anyTime).length,
        unavailable: answers.filter((a) => a.unavailable).length,
        freeSlots: ministryDayView(round, bookings, acting).find((candidate) => candidate.id === day.id)?.freeSlots ?? [],
        prioritySlots: ministryDayView(round, bookings, acting).find((candidate) => candidate.id === day.id)?.prioritySlots ?? [],
      };
    });

    return c.json({
      ...round,
      state: roundState(round, at),
      days,
      answeredBy: preferences.length,
      yourPreferences: acting ? ((await repo.getPreferences(round.roundId, acting))?.days ?? null) : null,
      term: ministryTerm(round),
      yourBookings: acting ? bookings.filter((booking) => booking.playerId === acting) : [],
      ...(isOfficer(p) ? { protections: round.protections ?? [] } : {}),
    });
  });

  /** R4/R5 explicitly expose or hide booking according to whether POP holds the Ministry. */
  app.put("/svs-rounds/:id/booking", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") throw new ValidationError("Choose whether Ministry signup is enabled.");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Ministry term not found.");
    await repo.setMinistryBookingEnabled(round.roundId, body.enabled, {
      id: p.sub,
      via: "web",
      reason: body.enabled ? "POP Ministry signup enabled" : "POP Ministry signup disabled",
    });
    return c.json({ bookingEnabled: body.enabled });
  });

  app.put("/svs-rounds/:id/protections", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Ministry term not found.");
    const protections = parseMinistryProtections(round, await readJson(c.req.raw));
    const bookings = await repo.listMinistryBookings(round.roundId);
    if (protections.some((protection) => bookings.some((booking) => booking.dayId === protection.dayId && protection.slots.includes(booking.slot)))) {
      throw new ConflictError("A protected range includes an appointment that is already booked.");
    }
    await repo.setMinistryProtections(round.roundId, protections, { id: p.sub, via: "web", reason: "Ministry rally-lead reservations updated" });
    return c.json({ protections });
  });

  /** POP members claim a free slot immediately; their saved game identity supplies all details. */
  app.post("/svs-rounds/:id/bookings", async (c) => {
    const p = c.get("principal");
    const playerId = defaultActing(p);
    if (!playerId) throw new ForbiddenError("Choose a linked game account before booking.");
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new ForbiddenError("This account cannot book a Ministry slot.");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Ministry term not found.");
    if (!round.bookingEnabled) throw new ConflictError("POP does not currently have the Ministry, so booking is not open.");
    const claim = parseSlotClaim(await readJson(c.req.raw));
    validateClaim(round, claim, now());
    if ((round.protections ?? []).some((protection) => protection.dayId === claim.dayId && protection.slots.includes(claim.slot) && Date.parse(protection.releasesAt) > now().getTime() && !protection.eligiblePlayerIds.includes(playerId))) {
      throw new ConflictError("That time is currently reserved for rally leads.");
    }
    const booking: MinistryBooking = {
      bookingId: ulid(),
      roundId: round.roundId,
      dayId: claim.dayId,
      slot: claim.slot,
      kind: "member",
      bookerKey: `MEMBER#${playerId}`,
      playerId,
      playerName: account.name,
      alliance: account.alliance,
      createdAt: now().toISOString(),
    };
    await repo.claimMinistryBooking(booking, { id: p.sub, via: "web", reason: "member Ministry booking" });
    return c.json(booking, 201);
  });

  app.delete("/svs-rounds/:id/bookings/:dayId/:slot", async (c) => {
    const p = c.get("principal");
    const playerId = defaultActing(p);
    if (!playerId) throw new ForbiddenError("Choose a linked game account before changing a booking.");
    const slot = Number(c.req.param("slot"));
    if (!Number.isInteger(slot)) throw new ValidationError("Invalid Ministry slot.");
    const booking = await repo.getMinistryBooking(c.req.param("id"), c.req.param("dayId"), slot);
    if (!booking) throw new NotFoundError("Booking not found.");
    if (booking.playerId !== playerId || booking.kind !== "member") throw new ForbiddenError("You can only cancel your own booking.");
    await repo.cancelMinistryBooking(booking, { id: p.sub, via: "web", reason: "member cancelled Ministry booking" });
    return c.json({ cancelled: true });
  });

  /** Your times for a round. Members answer for their own accounts, until the deadline. */
  app.put("/svs-rounds/:id/preferences/:pid", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    // Preferences are the member's own word about when they can play, so officers do not
    // overwrite them; after the deadline officers assign slots instead.
    if (!p.linkedAccounts.has(pid)) throw new ForbiddenError("You can only set your own times.");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Round not found.");
    if (!round.bookingEnabled) throw new ConflictError("POP does not currently have the Ministry, so signup is not open.");
    const preferences = parsePreferences(round, await readJson(c.req.raw), { playerId: pid, now: now() });
    const saved = await repo.setPreferences(preferences, { id: p.sub, via: "web" });
    return c.json(saved);
  });

  /** Kudos an officer awarded to a game account, with the decayed score they add up to. */
  app.get("/accounts/:pid/kudos", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    if (!p.linkedAccounts.has(pid)) requireOfficer(p);
    const awards = await repo.listKudos(pid);
    const at = now();
    return c.json({
      items: awards.map((award) => ({ ...award, ...kudosContribution(award, at) })),
      score: kudosScore(awards, at),
      decayDays: KUDOS_DECAY_DAYS,
    });
  });

  /** Officers award kudos for what the numbers cannot see. Awards are immutable. */
  app.post("/accounts/:pid/kudos", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const award = parseKudos(await readJson(c.req.raw), {
      awardId: ulid(),
      playerId: pid,
      awardedBy: p.sub,
      now: now(),
    });
    await repo.addKudos(award, { id: p.sub, via: "web", reason: "kudos awarded" });
    return c.json(award, 201);
  });

  // ---- Fortress reward buffs ----

  /** Current and recent distributable reward batches are visible to every alliance member. */
  app.get("/fortress-buffs", async (c) => {
    const principal = c.get("principal");
    const acting = defaultActing(principal);
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const accounts = new Map((await repo.listAccounts(alliance)).map((account) => [account.playerId, account.name]));
    const items = await Promise.all(
      (await repo.listFortressBuffPools(alliance)).map(async (pool) => ({
        ...pool,
        assignments: (await repo.listFortressBuffAssignments(pool.poolId)).map((assignment) => {
          const { eligibility, ...publicAssignment } = assignment;
          return {
            ...publicAssignment,
            ...(eligibility && (isOfficer(principal) || acting === assignment.playerId) ? { eligibility } : {}),
            name: accounts.get(assignment.playerId) ?? assignment.playerId,
          };
        }),
      })),
    );
    return c.json({ items });
  });

  app.get("/fortress-buffs/:id", async (c) => {
    const pool = await repo.getFortressBuffPool(c.req.param("id"));
    if (!pool) throw new NotFoundError("Fortress buff batch not found.");
    return c.json(await fortressBuffView(pool, c.get("principal")));
  });

  /** The acting account's immutable reward history, including the eligibility decision snapshot. */
  app.get("/reward-assignments/mine", async (c) => {
    const playerId = defaultActing(c.get("principal"));
    if (!playerId) return c.json({ items: [], currentCycle: null });
    const account = await repo.getAccount(playerId);
    if (!account) return c.json({ items: [], currentCycle: null });
    const pools = await repo.listFortressBuffPools(account.alliance);
    const items = (await Promise.all(pools.map(async (pool) => {
      const assignment = (await repo.listFortressBuffAssignments(pool.poolId)).find((item) => item.playerId === playerId);
      return assignment ? { ...assignment, pool } : undefined;
    })))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .toSorted((a, b) => b.assignedAt.localeCompare(a.assignedAt));
    const newest = pools.toSorted((a, b) => (b.registeredAt ?? b.acquiredAt).localeCompare(a.registeredAt ?? a.acquiredAt))[0];
    const cycleKey = (pool: FortressBuffPool) => pool.batchId ?? `legacy:${pool.acquiredAt}:${pool.source}:${pool.createdBy}`;
    const currentKey = newest ? cycleKey(newest) : undefined;
    const currentItems = currentKey ? items.filter((item) => cycleKey(item.pool) === currentKey) : [];
    return c.json({
      items,
      currentCycle: newest ? {
        source: newest.source,
        acquiredAt: newest.acquiredAt,
        items: currentItems,
      } : null,
    });
  });

  /** Full live reward ranking for R4/R5 planning, even before rewards are registered. */
  app.get("/reward-eligibility", async (c) => {
    await requireR4(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const { ranked, strongest, bestKudos } = await fortressRewardRanking(alliance);
    const eligibleThrough = Math.min(REWARD_RECIPIENTS, ranked.length);
    return c.json({
      alliance,
      generatedAt: now().toISOString(),
      totalMembers: ranked.length,
      eligibleThrough,
      items: ranked.map((candidate, index) => ({
        playerId: candidate.account.playerId,
        name: candidate.account.name,
        position: index + 1,
        eligible: index < eligibleThrough,
        eligibleThrough,
        score: candidate.score,
        participationRate: candidate.participationRate,
        participationSample: candidate.participationSample,
        participationAttended: candidate.participationAttended,
        participationNoShows: candidate.participationNoShows,
        participationUnregistered: candidate.participationUnregistered,
        strength: candidate.strength,
        strongestStrength: strongest,
        strengthShare: strongest > 0 ? candidate.strength / strongest : 0,
        kudosScore: candidate.kudos,
        bestKudosScore: bestKudos,
        kudosShare: candidate.kudosShare,
        weights: {
          participation: BUFF_ATTENDANCE_WEIGHT,
          strength: BUFF_STRENGTH_WEIGHT,
          kudos: BUFF_KUDOS_WEIGHT,
        },
        allocation: null,
      })),
    });
  });

  /** The acting account's live place in the same ranking used to assign Fortress rewards. */
  app.get("/reward-eligibility/mine", async (c) => {
    const playerId = defaultActing(c.get("principal"));
    if (!playerId) throw new NotFoundError("Choose a game account first.");
    const account = await repo.getAccount(playerId);
    if (!account) throw new NotFoundError("Game account not found.");
    const { ranked, strongest, bestKudos } = await fortressRewardRanking(account.alliance);
    const index = ranked.findIndex((candidate) => candidate.playerIds.includes(playerId));
    if (index < 0) throw new NotFoundError("This account is not in the active reward ranking.");
    const candidate = ranked[index]!;
    const eligibleThrough = Math.min(REWARD_RECIPIENTS, ranked.length);
    const pools = await repo.listFortressBuffPools(account.alliance);
    const newest = pools.toSorted((a, b) => (b.registeredAt ?? b.acquiredAt).localeCompare(a.registeredAt ?? a.acquiredAt))[0];
    const cycleKey = (item: FortressBuffPool) => item.batchId ?? `legacy:${item.acquiredAt}:${item.source}:${item.createdBy}`;
    const cyclePools = newest ? pools.filter((item) => cycleKey(item) === cycleKey(newest)) : [];
    const knownCycleValue = cyclePools.reduce((total, item) => ({
      min: total.min + (item.gemValuation ? item.quantity * item.gemValuation.min : 0),
      max: total.max + (item.gemValuation ? item.quantity * item.gemValuation.max : 0),
    }), { min: 0, max: 0 });
    const eligible = ranked.slice(0, eligibleThrough);
    const scoreTotal = eligible.reduce((sum, item) => sum + Math.max(0, item.score), 0);
    const share = index < eligibleThrough
      ? (scoreTotal > 0 ? Math.max(0, candidate.score) / scoreTotal : 1 / Math.max(1, eligibleThrough))
      : 0;
    const assigned = { min: 0, max: 0, unvaluedUnits: 0 };
    for (const item of cyclePools) {
      const assignment = (await repo.listFortressBuffAssignments(item.poolId)).find((entry) => entry.playerId === playerId);
      if (!assignment) continue;
      if (item.gemValuation) {
        assigned.min += assignment.amount * item.gemValuation.min;
        assigned.max += assignment.amount * item.gemValuation.max;
      } else {
        assigned.unvaluedUnits += assignment.amount;
      }
    }
    return c.json({
      playerId,
      position: index + 1,
      totalMembers: ranked.length,
      eligible: index < eligibleThrough,
      eligibleThrough,
      score: candidate.score,
      participationRate: candidate.participationRate,
      participationSample: candidate.participationSample,
      participationAttended: candidate.participationAttended,
      participationNoShows: candidate.participationNoShows,
      participationUnregistered: candidate.participationUnregistered,
      strength: candidate.strength,
      strongestStrength: strongest,
      strengthShare: strongest > 0 ? candidate.strength / strongest : 0,
      kudosScore: candidate.kudos,
      bestKudosScore: bestKudos,
      kudosShare: candidate.kudosShare,
      weights: {
        participation: BUFF_ATTENDANCE_WEIGHT,
        strength: BUFF_STRENGTH_WEIGHT,
        kudos: BUFF_KUDOS_WEIGHT,
      },
      allocation: newest ? {
        source: newest.source,
        targetValueMin: knownCycleValue.min * share,
        targetValueMax: knownCycleValue.max * share,
        assignedValueMin: assigned.min,
        assignedValueMax: assigned.max,
        assignedUnvaluedUnits: assigned.unvaluedUnits,
      } : null,
    });
  });

  /** R4/R5 register what the alliance won; this is inventory, not an assignment yet. */
  app.post("/fortress-buffs", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const pool = parseFortressBuffPool(await readJson(c.req.raw), {
      poolId: ulid(),
      batchId: ulid(),
      alliance: officer.alliance,
      createdBy: p.sub,
      now: now(),
    });
    await repo.putFortressBuffPool(pool, { id: p.sub, via: "web", reason: "Fortress reward registered" });
    return c.json({ ...pool, assignments: [] }, 201);
  });

  /** Register a whole takeover haul at once instead of submitting each buff type separately. */
  app.post("/fortress-buffs/bulk", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const batchId = ulid();
    const pools = parseFortressBuffPools(await readJson(c.req.raw), {
      poolIds: {
        allocatable: ulid(), speedup: ulid(), health: ulid(), hero_shard: ulid(), teleport: ulid(),
        damage: ulid(), deployment: ulid(), stronghold_material: ulid(), stronghold_component: ulid(),
        stronghold_hero_shard: ulid(), fire_crystal: ulid(),
      },
      batchId,
      alliance: officer.alliance,
      createdBy: p.sub,
      now: now(),
    });
    await repo.putFortressBuffPools(pools, { id: p.sub, via: "web", reason: "Fortress reward haul registered" });
    return c.json({ items: pools.map((pool) => ({ ...pool, assignments: [] })) }, 201);
  });

  /** Materialise the deterministic high-value-first recommendations for the newest cycle. */
  app.post("/fortress-buffs/plan-current", async (c) => {
    const p = c.get("principal");
    const officer = await requireR4(p);
    const pools = await repo.listFortressBuffPools(officer.alliance);
    const newest = pools.toSorted((a, b) => (b.registeredAt ?? b.acquiredAt).localeCompare(a.registeredAt ?? a.acquiredAt))[0];
    if (!newest) throw new NotFoundError("Register Fortress rewards before building a plan.");
    const cycleKey = (item: FortressBuffPool) => item.batchId ?? `legacy:${item.acquiredAt}:${item.source}:${item.createdBy}`;
    const cyclePools = pools
      .filter((item) => cycleKey(item) === cycleKey(newest) && item.gemValuation && item.remaining > 0)
      .toSorted((a, b) => {
        const aValue = (a.gemValuation!.min + a.gemValuation!.max) / 2;
        const bValue = (b.gemValuation!.min + b.gemValuation!.max) / 2;
        return bValue - aValue;
      });
    let recommendations = 0;
    let units = 0;
    for (const currentPool of cyclePools) {
      const view = await fortressBuffView(currentPool, p);
      for (const candidate of view.candidates.filter((item) => item.eligible && item.recommendedAmount > 0)) {
        if (
          candidate.score === undefined
          || candidate.participationRate === undefined
          || candidate.strength === undefined
          || candidate.strongestStrength === undefined
          || candidate.strengthShare === undefined
          || candidate.kudosShare === undefined
        ) continue;
        await repo.assignFortressBuff({
          poolId: currentPool.poolId,
          playerId: candidate.playerId,
          amount: candidate.recommendedAmount,
          eligibility: {
            position: candidate.position,
            eligibleThrough: Math.min(REWARD_RECIPIENTS, view.candidates.length + view.assignments.length),
            score: candidate.score,
            participationRate: candidate.participationRate,
            strength: candidate.strength,
            strongestStrength: candidate.strongestStrength,
            strengthShare: candidate.strengthShare,
            kudosShare: candidate.kudosShare,
            weights: {
              participation: BUFF_ATTENDANCE_WEIGHT,
              strength: BUFF_STRENGTH_WEIGHT,
              kudos: BUFF_KUDOS_WEIGHT,
            },
          },
          assignedAt: now().toISOString(),
          assignedBy: p.sub,
          status: "recommended",
        }, { id: p.sub, via: "web", reason: "Value-weighted Fortress reward plan generated" });
        recommendations += 1;
        units += candidate.recommendedAmount;
      }
    }
    return c.json({ recommendations, units, skippedUnvaluedPools: pools.filter((item) => cycleKey(item) === cycleKey(newest) && !item.gemValuation).length });
  });

  /** Assigning consumes the chosen quantity atomically and leaves an immutable recipient record. */
  app.post("/fortress-buffs/:id/assignments", async (c) => {
    const p = c.get("principal");
    await requireR4(p);
    const pool = await repo.getFortressBuffPool(c.req.param("id"));
    if (!pool) throw new NotFoundError("Fortress buff batch not found.");
    const body = (await readJson(c.req.raw)) as { playerId?: unknown; amount?: unknown };
    const playerId = parsePlayerId(body.playerId);
    const amount = Number(body.amount ?? 1);
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) {
      throw new ValidationError("Reward amount must be a whole number between 1 and 10,000.");
    }
    const view = await fortressBuffView(pool, p);
    const candidate = view.candidates.find((item) => item.playerId === playerId);
    if (!candidate?.eligible) {
      throw new ForbiddenError("This member is not currently eligible for this reward.");
    }
    if (
      candidate.score === undefined
      || candidate.participationRate === undefined
      || candidate.strength === undefined
      || candidate.strongestStrength === undefined
      || candidate.strengthShare === undefined
      || candidate.kudosShare === undefined
    ) {
      throw new ConflictError("The eligibility calculation could not be preserved. Reload before assigning.");
    }
    const assignment = await repo.assignFortressBuff(
      {
        poolId: pool.poolId,
        playerId,
        amount,
        eligibility: {
          position: candidate.position,
          eligibleThrough: Math.min(REWARD_RECIPIENTS, view.candidates.length),
          score: candidate.score,
          participationRate: candidate.participationRate,
          strength: candidate.strength,
          strongestStrength: candidate.strongestStrength,
          strengthShare: candidate.strengthShare,
          kudosShare: candidate.kudosShare,
          weights: {
            participation: BUFF_ATTENDANCE_WEIGHT,
            strength: BUFF_STRENGTH_WEIGHT,
            kudos: BUFF_KUDOS_WEIGHT,
          },
        },
        assignedAt: now().toISOString(),
        assignedBy: p.sub,
        status: "recommended",
      },
      { id: p.sub, via: "web", reason: "Fortress reward recommended" },
    );
    return c.json(assignment, 201);
  });

  /** A recommendation becomes historical receipt only after an officer confirms delivery. */
  app.post("/fortress-buffs/:id/assignments/:playerId/confirm", async (c) => {
    const p = c.get("principal");
    await requireR4(p);
    const pool = await repo.getFortressBuffPool(c.req.param("id"));
    if (!pool) throw new NotFoundError("Fortress reward pool not found.");
    const playerId = parsePlayerId(c.req.param("playerId"));
    const assignment = await repo.confirmFortressBuffAssignment(
      pool.poolId,
      playerId,
      now().toISOString(),
      { id: p.sub, via: "web", reason: "Fortress reward delivery confirmed" },
    );
    return c.json(assignment);
  });

  /** Officers change an event: title, type, start, deadline or notes. Answers stay. */
  app.patch("/events/:id", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const updated = parseEventChanges(event, await readJson(c.req.raw), now());
    await repo.updateEvent(updated, { id: p.sub, via: "web", reason: "event edited" });
    return c.json(updated);
  });

  /**
   * Repairs a legacy event that predates selectable parts. Existing yes answers are assigned to
   * the new part in the same transaction so result tooling never observes a half-migrated event.
   */
  app.post("/events/:id/session", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    if (event.sessions.length > 0) throw new ConflictError("This event already has a configured part.");
    const updated = configureLegacySession(event, await readJson(c.req.raw), now());
    const assignedSignups = await repo.configureLegacySession(
      updated,
      await repo.listAnswers(event.eventId),
      { id: p.sub, via: "web", reason: "legacy event part configured" },
    );
    return c.json({ event: updated, assignedSignups }, 201);
  });

  /** Upcoming events with the answer of the account the person is acting for. */
  app.get("/events", async (c) => {
    const p = c.get("principal");
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    const requestedFrom = c.req.query("from");
    if (requestedFrom && Number.isNaN(Date.parse(requestedFrom))) throw new ValidationError("from must be an ISO date or timestamp.");
    const from = requestedFrom
      ? new Date(requestedFrom).toISOString()
      : new Date(at.getTime() - PAST_EVENTS_MS).toISOString();
    const events = await repo.listEvents(alliance, from);
    const acting = defaultActing(p);
    const mine = acting ? await repo.answersForAccount(acting, from) : [];
    const byEvent = new Map(mine.map((a) => [a.eventId, a]));
    const attendanceByEvent = new Map(
      acting ? (await repo.attendanceFor(acting, 100)).map((record) => [record.eventId, record] as const) : [],
    );
    const officer = isOfficer(p);
    const orderedEvents = events.toSorted((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
    const items = await Promise.all(orderedEvents.map(async (event) => {
      const history = Date.parse(event.startsAt) < at.getTime()
        ? await (async () => {
            const results = await repo.listResults(event.eventId);
            const phaseRecords = await Promise.all(phasesForEvent(event.kind).map(async (phase) => ({
              phase,
              record: await repo.getEventPhaseScores(event.eventId, phase.key),
            })));
            const phases = phaseRecords.map(({ phase, record }) => {
              if (!record) return undefined;
              const visible = officer
                ? record.playerPoints
                : record.playerPoints.filter((row) => row.playerId === acting);
              return {
                phaseKey: phase.key,
                phaseLabel: phase.label,
                coverage: record.coverage,
                scoredPlayers: visible.length,
                reportedPlayerSubtotal: scoreSubtotal(visible),
                scope: officer ? "alliance" as const : "mine" as const,
              };
            }).filter((phase) => phase !== undefined);
            const personalScores = acting ? [
              ...results.flatMap((result) => personalEventScore(
                `session:${result.sessionId}`,
                event.sessions.find((session) => session.id === result.sessionId)?.label ?? result.sessionId,
                result.playerPoints,
                acting,
              )),
              ...phaseRecords.flatMap(({ phase, record }) => personalEventScore(
                `phase:${phase.key}`,
                phase.label,
                record?.playerPoints ?? [],
                acting,
              )),
            ] : [];
            const recordedAttendance = attendanceByEvent.get(event.eventId)?.status;
            const scoreProvesAttendance = acting ? results.some((result) => result.playerPoints.some(
              (row) => row.playerId === acting && scoreConfirmsAttendance(row, result.recordedBy),
            )) || phaseRecords.some(({ record }) => record?.playerPoints.some(
              (row) => row.playerId === acting && scoreConfirmsAttendance(row, record.recordedBy),
            )) === true : false;
            const zeroScoreProvesNoShow = acting ? results.some((result) => result.playerPoints.some(
              (row) => row.playerId === acting && row.points === 0,
            )) || phaseRecords.some(({ record }) => record?.playerPoints.some(
              (row) => row.playerId === acting && row.points === 0,
            )) === true : false;
            const personalAttendance = scoreProvesAttendance
              ? "attended" as const
              : recordedAttendance === "present"
                ? "attended" as const
                : recordedAttendance === "absent"
                  ? "did_not_attend" as const
                  : zeroScoreProvesNoShow
                    ? "did_not_attend" as const
                  : recordedAttendance === "excused"
                    ? "excused" as const
                    : "not_reviewed" as const;
            return {
              results: results.map((result) => ({
                sessionId: result.sessionId,
                sessionLabel: event.sessions.find((session) => session.id === result.sessionId)?.label ?? result.sessionId,
                outcome: result.outcome,
                ourScore: result.ourScore,
                opponentScore: result.opponentScore,
                ...(result.allianceScores ? { allianceScores: result.allianceScores } : {}),
                ...(officer ? { participants: result.playerPoints.filter((row) => scoreConfirmsAttendance(row, result.recordedBy)).length } : {}),
              })),
              phases,
              ...(acting ? {
                mine: {
                  attendance: personalAttendance,
                  attendanceEvidence: scoreProvesAttendance ? "score" as const : recordedAttendance && recordedAttendance !== "unknown" ? "record" as const : null,
                  scores: personalScores,
                },
              } : {}),
            };
          })()
        : undefined;
      return {
        ...event,
        closed: isClosed(event, at),
        myAnswer: byEvent.get(event.eventId)?.answer ?? null,
        mySessionId: byEvent.get(event.eventId)?.sessionId ?? null,
        myRegistrationRole: byEvent.get(event.eventId)?.registrationRole ?? null,
        ...(history ? { history } : {}),
      };
    }));
    return c.json({ items });
  });

  /** One event with its counts; officers also see who answered what and who is missing. */
  app.get("/events/:id", async (c) => {
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const answers = await repo.listAnswers(event.eventId);
    const accounts = await repo.listAccounts(event.alliance);
    // Anyone who can receive data can attend: members, guests, and accounts whose membership
    // is not confirmed yet (imported). Otherwise the table would show fewer people than answered.
    const expected = accounts.filter((a) => a.status === "active" || a.status === "guest" || a.status === "unknown");
    const counts = countAnswers(answers, expected.length);
    const acting = defaultActing(p);

    // Foundry strength and reliability of everyone who signed up, for the estimate.
    const yesAnswers = answers.filter((a) => a.answer === "yes");
    const lineups = new Map((await repo.listLineups(event.eventId)).map((l) => [l.sessionId, l]));
    const strategies = new Map((await repo.listStrategies(event.eventId)).map((strategy) => [strategy.sessionId, strategy]));
    const results = new Map((await repo.listResults(event.eventId)).map((result) => [result.sessionId, result]));
    const phaseScores = new Map(await Promise.all(phasesForEvent(event.kind).map(async (phase) => [
      phase.key,
      await repo.getEventPhaseScores(event.eventId, phase.key),
    ] as const)));
    const scoredPlayers = new Set([
      ...[...results.values()].flatMap((result) => result.playerPoints
        .filter((row) => scoreConfirmsAttendance(row, result.recordedBy))
        .map((row) => row.playerId)),
      ...[...phaseScores.values()].flatMap((result) => (result?.playerPoints ?? [])
        .filter((row) => scoreConfirmsAttendance(row, result?.recordedBy ?? ""))
        .map((row) => row.playerId)),
    ]);
    const zeroScorePlayers = new Set([
      ...[...results.values()].flatMap((result) => result.playerPoints
        .filter((row) => row.points === 0)
        .map((row) => row.playerId)),
      ...[...phaseScores.values()].flatMap((result) => (result?.playerPoints ?? [])
        .filter((row) => row.points === 0)
        .map((row) => row.playerId)),
    ]);
    // People in a published lineup need their strength shown too, even if an officer put someone
    // there who never answered.
    const needStrength = [
      ...new Set([...yesAnswers.map((a) => a.playerId), ...[...lineups.values()].flatMap((l) => l.entries.map((e) => e.playerId))]),
    ];
    const strengthOf = new Map<string, number | undefined>(
      await Promise.all(
        needStrength.map(async (pid) => [pid, currentOf(await repo.listReports(pid), "foundry_strength")] as const),
      ),
    );
    const participationFrom = new Date(now().getTime() - PARTICIPATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const pastEvents = await repo.listEvents(event.alliance, participationFrom, 100);
    const pastScores = await resultEvidence(pastEvents);
    const knownSince = new Map(accounts.map((a) => [a.playerId, a.createdAt]));
    const eventPeople = await attendancePeople(accounts);
    const membershipByPlayer = new Map<string, MembershipPeriod[]>();
    await Promise.all(eventPeople.map(async (group) => {
      const periods = await membershipPeriodsFor(group);
      for (const account of group) membershipByPlayer.set(account.playerId, periods);
    }));
    const participationOfPlayer = new Map(
      await Promise.all(
        yesAnswers.map(
          async (a) =>
            [
              a.playerId,
              participationOf({
                events: pastEvents,
                answers: await repo.answersForAccount(a.playerId, participationFrom),
                attendance: await repo.attendanceFor(a.playerId),
                scoreEvidence: [...(pastScores.byPlayer.get(a.playerId) ?? [])],
                noShowEvidence: [...(pastScores.noShowByPlayer.get(a.playerId) ?? [])],
                completeEvidence: [...pastScores.completeEvents],
                now: now(),
                ...(knownSince.get(a.playerId) ? { knownSince: knownSince.get(a.playerId)! } : {}),
                membershipPeriods: membershipByPlayer.get(a.playerId) ?? [],
              }),
            ] as const,
        ),
      ),
    );
    const byName = new Map(accounts.map((a) => [a.playerId, a.name]));
    const sessions = event.sessions.map((session) => {
      const entries = yesAnswers
        .filter((a) => a.sessionId === session.id)
        .map((a) => ({
          playerId: a.playerId,
          strength: strengthOf.get(a.playerId),
          attendanceRate: participationOfPlayer.get(a.playerId)?.rate,
          answeredAt: a.answeredAt,
          registrationRole: a.registrationRole,
        }));
      const standing = acting ? standingFor(session.id, entries, acting, session.starters) : undefined;
      // Everyone sees who signed up with their Foundry strength and likely role (that is what
      // decides the lineup). Reliability is officer business, as are power, furnace and notes.
      const ranked = rankSignUps(entries, session.starters).map((entry) => ({
        playerId: entry.playerId,
        name: byName.get(entry.playerId) ?? entry.playerId,
        foundryStrength: entry.strength ?? null,
        ...(isOfficer(p) ? { attendanceRate: entry.attendanceRate ?? null } : {}),
        position: entry.position,
        likely: entry.likely,
        ...(entry.registrationRole ? { registrationRole: entry.registrationRole } : {}),
      }));
      // Once officers publish, the lineup replaces the estimate as the answer to "am I playing?".
      const published = lineups.get(session.id);
      const lineup = published
        ? {
            version: published.version,
            publishedAt: published.publishedAt,
            ...(published.note ? { note: published.note } : {}),
            entries: published.entries.map((entry) => ({
              playerId: entry.playerId,
              name: byName.get(entry.playerId) ?? entry.playerId,
              role: entry.role,
              position: entry.position,
              foundryStrength: strengthOf.get(entry.playerId) ?? null,
              /** An officer may pick someone who never answered; the UI says so. */
              signedUp: entries.some((e) => e.playerId === entry.playerId),
            })),
          }
        : null;
      const myPlace = acting ? placeIn(published, acting) : undefined;
      const publishedStrategy = strategies.get(session.id);
      const strategy = publishedStrategy
        ? {
            version: publishedStrategy.version,
            body: publishedStrategy.body,
            publishedAt: publishedStrategy.publishedAt,
            assignments: publishedStrategy.assignments.map((assignment) => ({
              ...assignment,
              name: byName.get(assignment.playerId) ?? assignment.playerId,
            })),
          }
        : null;
      const yourAssignment = acting
        ? strategy?.assignments.find((assignment) => assignment.playerId === acting)
        : undefined;
      const recordedResult = results.get(session.id);
      const result = recordedResult
        ? {
            version: recordedResult.version,
            outcome: recordedResult.outcome,
            ourScore: recordedResult.ourScore,
            opponentScore: recordedResult.opponentScore,
            ...(recordedResult.allianceScores ? { allianceScores: recordedResult.allianceScores } : {}),
            ...(recordedResult.ourMatchmakingPower !== undefined ? { ourMatchmakingPower: recordedResult.ourMatchmakingPower } : {}),
            ...(recordedResult.opponentMatchmakingPower !== undefined
              ? { opponentMatchmakingPower: recordedResult.opponentMatchmakingPower }
              : {}),
            ...(recordedResult.opponentCombatants !== undefined ? { opponentCombatants: recordedResult.opponentCombatants } : {}),
            ...(recordedResult.notes ? { notes: recordedResult.notes } : {}),
            recordedAt: recordedResult.recordedAt,
            playerPoints: recordedResult.playerPoints
              .filter((row) => isOfficer(p) || row.playerId === acting)
              .map((row) => ({ ...row, name: byName.get(row.playerId) ?? row.playerId })),
          }
        : null;
      return {
        ...session,
        signedUp: entries.length,
        spotsLeft:
          session.starters === undefined ? null : Math.max(0, session.starters + (session.subs ?? 0) - entries.length),
        signedUpList: ranked,
        lineup,
        strategy,
        result,
        ...(myPlace ? { yourPlace: { role: myPlace.role, position: myPlace.position } } : {}),
        ...(yourAssignment
          ? {
              yourAssignment: {
                role: yourAssignment.role,
                ...(yourAssignment.duty ? { duty: yourAssignment.duty } : {}),
                ...(yourAssignment.note ? { note: yourAssignment.note } : {}),
              },
            }
          : {}),
        ...(standing ? { yourStanding: standing } : {}),
      };
    });

    const eventType = (await repo.getEventType(event.kind)) ?? STARTER_TYPES.find((type) => type.typeId === event.kind);

    const scoreboards = phasesForEvent(event.kind).length > 0
      ? Object.fromEntries(await Promise.all(phasesForEvent(event.kind).map(async (phase) => {
          const record = phaseScores.get(phase.key);
          const visible = isOfficer(p) ? (record?.playerPoints ?? []) : (record?.playerPoints ?? []).filter((row) => row.playerId === acting);
          const entries = visible.map((row, index) => ({ ...row, rank: isOfficer(p) ? index + 1 : undefined, name: byName.get(row.playerId) ?? row.playerId, mine: row.playerId === acting }));
          return [phase.key, {
            phaseKey: phase.key,
            phaseLabel: phase.label,
            version: record?.version ?? 0,
            coverage: record?.coverage ?? null,
            scoredPlayers: isOfficer(p) ? (record?.playerPoints.length ?? 0) : entries.length,
            reportedPlayerSubtotal: scoreSubtotal(isOfficer(p) ? (record?.playerPoints ?? []) : visible),
            entries,
          }] as const;
        })))
      : undefined;

    const body: Record<string, unknown> = {
      ...event,
      sessions,
      closed: isClosed(event, now()),
      counts,
      myAnswer: (() => {
        const acting = defaultActing(p);
        return acting ? (answers.find((a) => a.playerId === acting)?.answer ?? null) : null;
      })(),
      mySessionId: (() => {
        const acting = defaultActing(p);
        return acting ? (answers.find((a) => a.playerId === acting)?.sessionId ?? null) : null;
      })(),
      myRegistrationRole: (() => {
        const acting = defaultActing(p);
        return acting ? (answers.find((a) => a.playerId === acting)?.registrationRole ?? null) : null;
      })(),
      ...(eventType?.strategyTemplate ? { strategyTemplate: eventType.strategyTemplate } : {}),
      ...(scoreboards ? { scoreboards } : {}),
    };
    if (isOfficer(p)) {
      const checklist = await repo.getChecklist(event.eventId);
      if (checklist) {
        body.checklist = { version: checklist.version, tasks: datedTasks(event, checklist.entries, now()) };
      }
      body.ownerName = event.ownerPlayerId ? (byName.get(event.ownerPlayerId) ?? null) : null;
      const byPlayer = new Map(answers.map((a) => [a.playerId, a]));
      const attendance = new Map((await repo.listAttendance(event.eventId)).map((a) => [a.playerId, a]));
      const history = new Map(
        await Promise.all(expected.map(async (a) => [a.playerId, await repo.attendanceFor(a.playerId)] as const)),
      );
      // Officers see the numbers they need to balance the legions (P8/EVT-04).
      const reports = new Map(
        await Promise.all(expected.map(async (a) => [a.playerId, await repo.listReports(a.playerId)] as const)),
      );
      // Where each person ended up in a published lineup, so the officer table shows the decision
      // next to the numbers it was based on.
      const placeOf = new Map<string, { sessionId: string; role: string; position: number }>();
      for (const l of lineups.values()) {
        for (const e of l.entries) placeOf.set(e.playerId, { sessionId: l.sessionId, role: e.role, position: e.position });
      }
      body.members = expected.map((account) => {
        const own = reports.get(account.playerId) ?? [];
        const current = currentValues(own);
        const troopValue = (type: "infantry" | "lancer" | "marksman") => {
          const level = current[`troop_level_${type}`]?.value;
          const helios = current[`helios_${type}`]?.value;
          return {
            level: typeof level === "string" ? level : null,
            helios: helios === "yes" ? true : helios === "no" ? false : null,
          };
        };
        const troopReportAt = [
          "furnace_level",
          "troop_level_infantry", "helios_infantry",
          "troop_level_lancer", "helios_lancer",
          "troop_level_marksman", "helios_marksman",
        ].flatMap((metric) => {
          const effectiveAt = current[metric as keyof typeof current]?.effectiveAt;
          return effectiveAt ? [effectiveAt] : [];
        }).toSorted().at(-1) ?? null;
        return {
          playerId: account.playerId,
          name: account.name,
          rank: account.rank ?? null,
          answer: byPlayer.get(account.playerId)?.answer ?? null,
          sessionId: byPlayer.get(account.playerId)?.sessionId ?? null,
          answeredAt: byPlayer.get(account.playerId)?.answeredAt ?? null,
          registrationRole: byPlayer.get(account.playerId)?.registrationRole ?? null,
          attended: scoredPlayers.has(account.playerId)
            ? "present"
            : zeroScorePlayers.has(account.playerId)
              ? "absent"
              : (attendance.get(account.playerId)?.status ?? null),
          attendedByScore: scoredPlayers.has(account.playerId),
          lineup: placeOf.get(account.playerId) ?? null,
          strengthTrend: monthlyValues(seriesOf(own, "foundry_strength"), now()),
          attendanceTrend: trailingAverage(monthlyAttendance(history.get(account.playerId) ?? [], now())),
          power: currentOf(own, "city_power") ?? null,
          foundryStrength: currentOf(own, "foundry_strength") ?? null,
          furnace: current.furnace_level?.value ?? null,
          troops: {
            infantry: troopValue("infantry"),
            lancer: troopValue("lancer"),
            marksman: troopValue("marksman"),
          },
          troopReportAt,
          lastReportAt: own.length > 0 ? (current.city_power?.effectiveAt ?? null) : null,
        };
      });
    }
    return c.json(body);
  });

  /** A player can report only their own phase score; officers can correct an alliance account. */
  app.put("/events/:id/phases/:phase/scores/:pid", async (c) => {
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const phase = scorePhaseFor(event.kind, c.req.param("phase"));
    const playerId = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, playerId);
    const account = await repo.getAccount(playerId);
    if (!account || account.alliance !== event.alliance) throw new ValidationError(`Player ID ${playerId} is not in ${event.alliance}.`);
    const parsed = parseSelfScore(await readJson(c.req.raw));
    const current = await repo.getEventPhaseScores(event.eventId, phase.key);
    const desired = upsertPhaseScores(current, {
      expectedVersion: current?.version ?? 0,
      coverage: current?.coverage ?? "partial",
      playerPoints: [{ playerId, points: parsed.points }],
      source: { type: role === "officer" ? "officer_correction" : "self_report" },
    }, {
      eventId: event.eventId,
      phaseKey: phase.key,
      phaseLabel: phase.label,
      recordedAt: now().toISOString(),
      recordedBy: p.sub,
    });
    await repo.putEventPhaseScores(desired, { id: p.sub, via: "web", reason: role === "officer" ? "phase score corrected" : "phase score self-reported" });
    return c.json({ playerId, points: parsed.points, version: desired.version });
  });

  /** Officer UI bulk upsert. Bot automation uses the stricter guarded preview/apply route. */
  app.post("/events/:id/phases/:phase/scores/import", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const phase = scorePhaseFor(event.kind, c.req.param("phase"));
    const input = parsePhaseScoreUpsert(await readJson(c.req.raw));
    const current = await repo.getEventPhaseScores(event.eventId, phase.key);
    if (input.expectedVersion !== (current?.version ?? 0)) throw new ConflictError("The phase scores changed. Reload and try again.");
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = input.playerPoints.filter((score) => !known.has(score.playerId)).map((score) => score.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);
    const desired = upsertPhaseScores(current, input, { eventId: event.eventId, phaseKey: phase.key, phaseLabel: phase.label, recordedAt: now().toISOString(), recordedBy: p.sub });
    await repo.putEventPhaseScores(desired, { id: p.sub, via: "web", reason: `${phase.key} scores imported` });
    return c.json({ imported: input.playerPoints.length, version: desired.version });
  });

  /**
   * Publishes the lineup for one part of an event (P5.4). Officers only: this is the decision
   * that turns the strength estimate into "you are starting". Sending the version they edited
   * makes a stale publish fail instead of overwriting a colleague's work.
   */
  app.post("/events/:id/sessions/:sid/lineup", async (c) => {
    requireOfficer(c.get("principal"));
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((s) => s.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");

    const current = await repo.getLineup(event.eventId, session.id);
    const lineup = parseLineup(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      sessionId: session.id,
      publishedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    });
    // Everyone in a lineup must be an account we know; an unknown Player ID is a typo, not a plan.
    const known = new Set((await repo.listAccounts(event.alliance)).map((a) => a.playerId));
    const strangers = lineup.entries.filter((e) => !known.has(e.playerId)).map((e) => e.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    await repo.putLineup(lineup, { id: p.sub, via: "web", reason: "lineup published" });
    return c.json(lineup, 201);
  });

  /** Publishes the plan and assignments for one event part (P5.5). */
  app.post("/events/:id/sessions/:sid/strategy", async (c) => {
    requireOfficer(c.get("principal"));
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");

    const current = await repo.getStrategy(event.eventId, session.id);
    const strategy = parseStrategy(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      sessionId: session.id,
      publishedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    });

    // Assignments describe the published lineup; a strategy may still contain body-only guidance
    // before a lineup exists, but it cannot quietly assign someone who was not selected.
    if (strategy.assignments.length > 0) {
      const lineup = await repo.getLineup(event.eventId, session.id);
      if (!lineup) throw new ValidationError("Publish the lineup before assigning strategy roles.");
      const selected = new Set(lineup.entries.map((entry) => entry.playerId));
      const outside = strategy.assignments.filter((assignment) => !selected.has(assignment.playerId)).map((assignment) => assignment.playerId);
      if (outside.length > 0) throw new ValidationError(`Not in the published ${session.label} lineup: ${outside.join(", ")}.`);
    }

    await repo.putStrategy(strategy, { id: p.sub, via: "web", reason: "strategy published" });
    return c.json(strategy, 201);
  });

  /** Records or corrects the outcome of one event part (P5.6b). */
  app.post("/events/:id/sessions/:sid/result", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    if (Date.parse(session.startsAt) > now().getTime()) throw new ValidationError("Record the result after this event part starts.");

    const current = await repo.getResult(event.eventId, session.id);
    const result = await withKnownResultRoles(parseEventResult(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      eventKind: event.kind,
      recordedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    }));
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = result.playerPoints.filter((row) => !known.has(row.playerId)).map((row) => row.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    await repo.putResult(result, { id: p.sub, via: "web", reason: "event result recorded" });
    return c.json(result, 201);
  });

  /** Answers for a game account: the player for their own accounts, officers for anyone. */
  app.put("/events/:id/answers/:pid", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, pid);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const choice = parseAnswerChoice(event, body);
    const saved = await repo.setAnswer(
      event,
      pid,
      choice,
      role,
      { id: p.sub, via: "web", ...(role === "officer" ? { reason: "officer edit" } : {}) },
      typeof body.note === "string" ? body.note.trim().slice(0, 200) : undefined,
      // Officers keep adjusting the list after answers close, up to the start of the event.
      { afterDeadline: role === "officer" },
    );
    return c.json(saved);
  });

  app.post("/accounts/:pid/reports", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, pid);
    const report = parseReport(await readJson(c.req.raw), {
      playerId: pid,
      reportId: ulid(),
      source: role,
      now: now(),
    });
    await repo.addReport(report, { id: p.sub, via: "web" });
    return c.json(report, 201);
  });

  app.put("/accounts/:pid/reports/:reportId/ignored", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, pid);
    const report = await repo.getReport(pid, c.req.param("reportId"));
    if (!report) throw new NotFoundError("Report not found.");
    const officer = isOfficer(p);
    if (!officer && role === "player" && report.source !== "player") {
      throw new ForbiddenError("You can only ignore reports you submitted yourself.");
    }
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    if (typeof body.ignored !== "boolean") throw new ValidationError("ignored must be true or false.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 300) throw new ValidationError("Give a reason between 3 and 300 characters.");
    if (body.ignored === Boolean(report.ignoredAt)) {
      throw new ConflictError(body.ignored ? "That report is already ignored." : "That report is not ignored.");
    }
    const actingId = defaultActing(p);
    const actingAccount = actingId ? await repo.getAccount(actingId) : undefined;
    const saved = await repo.setReportIgnored(
      pid,
      report.reportId,
      body.ignored,
      { id: p.sub, via: "web", reason },
      actingAccount?.name ?? (officer ? "Officer" : "Member"),
    );
    return c.json(saved);
  });

  extend?.(app);
  return app;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be JSON.");
  }
}

interface AgentWriteRequest {
  apply: boolean;
  reason: string;
  expectedHash: string;
  key: string;
  bodyHash: string;
}

function agentWriteRequest(body: Record<string, unknown>, apply: boolean, key = "", subject = "historical data"): AgentWriteRequest {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
  if (apply) {
    if (!reason || !expectedHash) throw new ValidationError(`Applying ${subject} requires a reason and the expectedHash from preview.`);
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
  }
  return {
    apply,
    reason,
    expectedHash,
    key,
    bodyHash: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  };
}

function stateHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex");
}

function assertPreviewState(write: AgentWriteRequest, currentHash: string, current?: unknown, desired?: unknown): void {
  if (write.apply && write.expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(desired)) {
    throw new ConflictError("Historical data changed after preview. Preview again before applying.");
  }
}

function historicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${field} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function historicalRecordId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value)) throw new ValidationError("Invalid historical record id.");
  return value;
}

function agentActor(tokenId: string, reason: string): Actor {
  return { id: tokenId, via: `agent:${tokenId}`, reason };
}

function requireAgentOfficer(groups: ReadonlySet<string>): void {
  if (!groups.has("officer") && !groups.has("owner")) throw new ForbiddenError("The token issuer is no longer allowed to read officer history.");
}

function replayAgentChange(
  c: Context<Env>,
  replay: { bodyHash: string; response: unknown },
  bodyHash: string,
  field: string,
): Response {
  if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
  return c.json({ dryRun: false, replayed: true, [field]: replay.response });
}
