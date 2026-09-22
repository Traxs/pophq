// Typed client for the parts of /v1 this page uses. Will be generated from OpenAPI later.

export interface GameAccount {
  playerId: string;
  name: string;
  alliance: string;
  rank?: string;
  status: string;
  /** An officer's note about this account. */
  note?: string;
}

export interface Me {
  sub: string;
  groups: string[];
  accounts: GameAccount[];
}

export interface MeasurementValue {
  metric: string;
  value: number | string;
  unit: string;
}

export interface Report {
  reportId: string;
  effectiveAt: string;
  recordedAt: string;
  source: string;
  values: MeasurementValue[];
  supersedesReportId?: string;
}

export interface Reports {
  items: Report[];
  current: Record<string, MeasurementValue & { effectiveAt: string }>;
}

export interface RosterRow extends GameAccount {
  /** Whether this game account is already claimed by a POP HQ sign-in. */
  hasLogin: boolean;
  /** Six trailing months, oldest first; null for a month with nothing to say. */
  powerTrend: (number | null)[];
  strengthTrend: (number | null)[];
  attendanceTrend: (number | null)[];
  power: number | null;
  previousPower: number | null;
  foundryStrength: number | null;
  attendance: Participation;
  /** The latest Foundry-strength report; separate from the city-power report date below. */
  lastFoundryReportAt: string | null;
  /** The latest city-power report. */
  lastReportAt: string | null;
  furnace: string | null;
  reports: number;
}

/** What an officer may change about an account; "" clears a rank or a note. */
export interface AccountChanges {
  name?: string;
  alliance?: string;
  rank?: string;
  status?: "active" | "guest" | "unknown" | "transferred_out";
  note?: string;
}

export interface Seats {
  used: number;
  cap: number;
}

export interface Roster {
  items: RosterRow[];
  seats: Seats;
}

export interface InviteInput {
  loginMethod: "email" | "password";
  email?: string;
  playerId: string;
  name: string;
  rank?: string;
}

export interface InviteResult {
  account: GameAccount;
  accountCreated: boolean;
  sub?: string;
  loginCreated: boolean;
  linked: boolean;
  /** One-time bootstrap credentials for a password invitation. */
  credentials?: { username: string; password: string };
  seats: Seats;
}

export type AgentScope = "all:read" | "results:read" | "results:write" | "events:write" | "history:write" | "rewards:write";
export interface AgentTokenInfo {
  tokenId: string;
  name: string;
  scopes: AgentScope[];
  issuedBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
export interface IssuedAgentToken extends AgentTokenInfo { token: string }

export interface KudosAwardView {
  awardId: string;
  playerId: string;
  points: number;
  reason: string;
  awardedAt: string;
  currentPoints: number;
  remainingShare: number;
  ageDays: number;
  daysRemaining: number;
  expiresAt: string;
  active: boolean;
}

export interface KudosSummary {
  items: KudosAwardView[];
  /** Sum of every award's current, decayed contribution. */
  score: number;
  decayDays: number;
}

export interface RewardEligibility {
  playerId: string;
  position: number;
  totalMembers: number;
  eligible: boolean;
  eligibleThrough: number;
  score: number;
  participationRate: number;
  strength: number;
  strongestStrength: number;
  strengthShare: number;
  kudosScore: number;
  bestKudosScore: number;
  kudosShare: number;
  weights: { participation: number; strength: number; kudos: number };
  allocation: {
    source: string;
    targetValueMin: number;
    targetValueMax: number;
    assignedValueMin: number;
    assignedValueMax: number;
    assignedUnvaluedUnits: number;
  } | null;
}

export type FortressBuff =
  | "allocatable"
  | "speedup"
  | "health"
  | "hero_shard"
  | "teleport"
  | "damage"
  | "deployment"
  | "stronghold_material"
  | "stronghold_component"
  | "stronghold_hero_shard"
  | "fire_crystal";

export interface FortressBuffAssignmentView {
  poolId: string;
  playerId: string;
  name: string;
  amount: number;
  eligibility?: RewardEligibilitySnapshot;
  assignedAt: string;
  assignedBy: string;
  status: "recommended" | "confirmed";
  confirmedAt?: string;
  confirmedBy?: string;
}

export interface RewardEligibilitySnapshot {
  position: number;
  eligibleThrough: number;
  score: number;
  participationRate: number;
  strength: number;
  strongestStrength: number;
  strengthShare: number;
  kudosShare: number;
  weights: { participation: number; strength: number; kudos: number };
}

export interface MemberRewardAssignment extends FortressBuffAssignmentView {
  pool: Omit<FortressBuffPool, "assignments">;
}

export interface CurrentRewardCycle {
  source: string;
  acquiredAt: string;
  items: MemberRewardAssignment[];
}

export interface FortressBuffPool {
  poolId: string;
  batchId?: string;
  alliance: string;
  buff: FortressBuff;
  quantity: number;
  remaining: number;
  source: string;
  acquiredAt: string;
  registeredAt?: string;
  createdBy: string;
  gemValuation?: {
    min: number;
    max: number;
    confidence: "high" | "medium" | "low";
    basis: string;
  };
  assignments: FortressBuffAssignmentView[];
}

export interface FortressBuffCandidate {
  playerId: string;
  name: string;
  position: number;
  eligible: boolean;
  /** Officers only: the weighted result and its three inputs. */
  score?: number;
  participationRate?: number;
  strength?: number;
  strongestStrength?: number;
  strengthShare?: number;
  kudosShare?: number;
  /** Known Gem-equivalent value already assigned to this member in the same takeover cycle. */
  cycleRewardValueMin: number;
  cycleRewardValueMax: number;
  cycleUnvaluedUnits: number;
  cycleTargetValueMin: number;
  cycleTargetValueMax: number;
  /** Quantity suggested by the score-weighted, high-value-first cycle plan. */
  recommendedAmount: number;
}

export interface FortressBuffDetail extends FortressBuffPool {
  candidates: FortressBuffCandidate[];
}

export type EventKind = "foundry" | "svs" | "fdt" | "canyon" | "tundra" | "bear" | "other";
export type Answer = "yes" | "no" | "maybe";

export interface EventSession {
  id: string;
  label: string;
  startsAt: string;
  /** How many start; the rest are substitutes. Absent means no limit. */
  starters?: number;
  subs?: number;
}

export interface SessionStanding {
  sessionId: string;
  position: number;
  signedUp: number;
  likely: "starter" | "sub";
  estimate: true;
}

export interface SignUpEntry {
  playerId: string;
  name: string;
  /** The number that decides the lineup; visible to every member. */
  foundryStrength: number | null;
  /** Share of kept commitments; officers only, and only once attendance is tracked. */
  attendanceRate?: number | null;
  position: number;
  likely: "starter" | "sub";
}

export type LineupRole = "starter" | "sub";

export interface LineupEntryView {
  playerId: string;
  name: string;
  role: LineupRole;
  /** Order within the role, 1-based. */
  position: number;
  foundryStrength: number | null;
  /** False when an officer picked someone who never answered. */
  signedUp: boolean;
}

/** The lineup officers published for one part: the decision, not the estimate (P5.4). */
export interface PublishedLineup {
  version: number;
  publishedAt: string;
  note?: string;
  entries: LineupEntryView[];
}

export const STRATEGY_ROLES = ["Holder", "Looter", "Substitute Looter", "Farmer"] as const;
export type StrategyRole = (typeof STRATEGY_ROLES)[number];

export interface StrategyAssignmentView {
  playerId: string;
  name: string;
  role: StrategyRole;
  duty?: string;
  note?: string;
}

export interface PublishedStrategy {
  version: number;
  body: string;
  publishedAt: string;
  assignments: StrategyAssignmentView[];
}

export type EventOutcome = "win" | "loss" | "draw";

export interface PublishedResult {
  version: number;
  outcome: EventOutcome;
  ourScore: number;
  opponentScore: number;
  ourMatchmakingPower?: number;
  opponentMatchmakingPower?: number;
  opponentCombatants?: number;
  notes?: string;
  recordedAt: string;
  /** Officers receive every known entry; members receive only their own. */
  playerPoints: { playerId: string; name: string; points: number }[];
}

/** A session as the event page shows it: with live counts and where you stand. */
export interface SessionView extends EventSession {
  signedUp: number;
  spotsLeft: number | null;
  signedUpList: SignUpEntry[];
  /** Null until officers publish; then it replaces the estimate. */
  lineup: PublishedLineup | null;
  /** Null until officers publish the plan for this part. */
  strategy: PublishedStrategy | null;
  /** Null until an officer records the outcome. */
  result?: PublishedResult | null;
  /** Your place in the published lineup, if you are in it. */
  yourPlace?: { role: LineupRole; position: number };
  yourAssignment?: { role: StrategyRole; duty?: string; note?: string };
  yourStanding?: SessionStanding;
}

export interface AllianceEvent {
  eventId: string;
  alliance: string;
  kind: EventKind;
  title: string;
  startsAt: string;
  deadlineAt: string;
  notes?: string;
  /** Parts people choose between, e.g. the two Foundry legions. Empty for a plain event. */
  sessions: EventSession[];
  createdBy: string;
  /** The officer's game account that runs this one. */
  ownerPlayerId?: string;
}

export interface EventListItem extends AllianceEvent {
  closed: boolean;
  myAnswer: Answer | null;
  /** Which session they picked, when the event has sessions. */
  mySessionId: string | null;
}

export interface AnswerCounts {
  yes: number;
  no: number;
  maybe: number;
  pending: number;
  /** Yes answers per session id, e.g. { L1: 19, L2: 30 }. */
  bySession: Record<string, number>;
}

export type AttendanceStatus = "present" | "absent" | "excused" | "unknown";

export type Outcome = "attended" | "no_show" | "unregistered" | "excused" | "not_counted";

export interface ParticipationEvent {
  eventId: string;
  title: string;
  startsAt: string;
  outcome: Outcome;
}

/**
 * How much the alliance can count on somebody: attending earns credit, signing up and not
 * turning up costs double, and never answering costs half. Absent rate means nothing counted,
 * which is not the same as zero.
 */
export interface Participation {
  rate?: number;
  attended: number;
  noShows: number;
  unregistered: number;
  excused: number;
  sample: number;
  events: ParticipationEvent[];
}

export interface EventMember {
  playerId: string;
  name: string;
  rank: string | null;
  answer: Answer | null;
  sessionId: string | null;
  answeredAt: string | null;
  /** Officer view only. */
  attended: AttendanceStatus | null;
  /** Where this member ended up in a published lineup, if anywhere. */
  lineup: { sessionId: string; role: LineupRole; position: number } | null;
  strengthTrend: (number | null)[];
  attendanceTrend: (number | null)[];
  power: number | null;
  foundryStrength: number | null;
  furnace: string | number | null;
  lastReportAt: string | null;
}

export type TaskState = "done" | "overdue" | "due" | "upcoming";

export interface ChecklistTask {
  id: string;
  label: string;
  note?: string;
  dueAt: string;
  state: TaskState;
  doneAt?: string;
  doneBy?: string;
}

/** A job an officer still has to do, across every event that has not finished. */
export interface OfficerJob {
  eventId: string;
  eventTitle: string;
  startsAt: string;
  ownerPlayerId: string | null;
  ownerName: string | null;
  /** True when the reader's own account runs that event. */
  mine: boolean;
  taskId: string;
  label: string;
  /** Always a job that can still be done: a missed one lives on the event page instead. */
  dueAt: string;
}

export interface EventDetail extends Omit<EventListItem, "sessions"> {
  sessions: SessionView[];
  counts: AnswerCounts;
  /** Starting text for a new strategy, inherited from the event type. */
  strategyTemplate?: string;
  /** Officers only. */
  members?: EventMember[];
  /** Officers only: the jobs for running this event. */
  checklist?: { version: number; tasks: ChecklistTask[] };
  /** The name behind ownerPlayerId, for display. */
  ownerName?: string | null;
}

export type Buff = "construction" | "research" | "training";
export type RoundState = "collecting" | "planning" | "published" | "closed";

export interface BuffDayView {
  id: string;
  buff: Buff;
  /** The buff day in UTC, YYYY-MM-DD. */
  date: string;
  /** Slot 0's start, so the UI can work out every other slot locally. */
  startsAt: string;
  endsAt: string;
  /** How many people asked for each of the 48 slots. */
  demand: number[];
  anyTime: number;
  unavailable: number;
}

export interface DayPreferenceInput {
  dayId: string;
  slots?: number[];
  anyTime?: boolean;
  unavailable?: boolean;
  note?: string;
}

export interface SvsRoundListItem {
  roundId: string;
  label: string;
  alliance: string;
  preferenceDeadline: string;
  publishedAt?: string;
  state: RoundState;
  /** Whether the account you are acting as has answered. */
  answered: boolean;
  days: { id: string; buff: Buff; date: string }[];
}

export interface SvsRoundDetail extends Omit<SvsRoundListItem, "days" | "answered"> {
  days: BuffDayView[];
  answeredBy: number;
  yourPreferences: DayPreferenceInput[] | null;
}

export interface NewEvent {
  kind: EventKind;
  title: string;
  startsAt: string;
  /** Parts people choose between; a player picks at most one. */
  sessions?: { id?: string; label: string; startsAt: string }[];
  /** Whole days before the start; the deadline is the end of that day in the officer's time zone. */
  answersCloseDaysBefore?: number;
  timeZoneOffsetMinutes?: number;
  deadlineAt?: string;
  notes?: string;
  /** The officer's game account that runs it; "" hands it back to nobody. */
  ownerPlayerId?: string;
}

export type EventChanges = Partial<NewEvent>;

export interface GrowthPoint {
  at: string;
  total: number;
  average: number;
  members: number;
}

export interface Mover {
  playerId: string;
  name: string;
  from: number;
  to: number;
  change: number;
  percent: number;
}

/** Strength comes in kinds; each is its own metric (city power is not Foundry strength). */
export const STRENGTH_METRICS = [
  { value: "city_power", label: "Power" },
  { value: "foundry_strength", label: "Foundry" },
] as const;
export type StrengthMetric = (typeof STRENGTH_METRICS)[number]["value"];

export interface AllianceGrowth {
  metric: StrengthMetric;
  weeks: number;
  alliance: string;
  cohort: "members" | "all";
  unknownMembership: number;
  points: GrowthPoint[];
  gainers: Mover[];
  stalled: Mover[];
  missing: { playerId: string; name: string }[];
}

export interface AllianceAttendanceGrowth {
  alliance: string;
  weeks: number;
  points: { at: string; value: number; events: number; records: number }[];
}

export type ParticipationCategory = "always" | "sometimes" | "never" | "no_history";

export interface EventParticipationMember {
  playerId: string;
  name: string;
  rank?: string;
  attended: number;
  events: number;
  rate?: number;
  category: ParticipationCategory;
  lastAttendedAt?: string;
}

export interface EventParticipationMetrics extends AllianceAttendanceGrowth {
  kind: EventKind;
  eventCount: number;
  members: EventParticipationMember[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TokenSource = () => string | undefined | Promise<string | undefined>;

export function createRequest(getToken: TokenSource, actingAs?: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (actingAs) headers["x-account-id"] = actingAs;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const title = (data as { title?: string }).title ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, title);
    }
    return data as T;
  };
}

export function createApi(getToken: TokenSource, actingAs?: string) {
  const request = createRequest(getToken, actingAs);
  return {
    me: () => request<Me>("GET", "/me"),
    reports: (playerId: string) => request<Reports>("GET", `/accounts/${playerId}/reports`),
    addReport: (playerId: string, values: { metric: string; value: string | number }[]) =>
      request<Report>("POST", `/accounts/${playerId}/reports`, { values }),
    roster: () => request<Roster>("GET", "/roster"),
    invite: (input: InviteInput) => request<InviteResult>("POST", "/invites", input),
    updateAccount: (playerId: string, changes: AccountChanges) =>
      request<GameAccount>("PATCH", `/accounts/${playerId}`, changes),
    agentTokens: () => request<{ items: AgentTokenInfo[] }>("GET", "/agent-tokens"),
    issueAgentToken: (input: { name: string; scopes: AgentScope[]; expiresInDays: number }) =>
      request<IssuedAgentToken>("POST", "/agent-tokens", input),
    revokeAgentToken: (tokenId: string) => request<{ revoked: true }>("DELETE", `/agent-tokens/${tokenId}`),
    fortressBuffs: () => request<{ items: FortressBuffPool[] }>("GET", "/fortress-buffs"),
    fortressBuff: (poolId: string) => request<FortressBuffDetail>("GET", `/fortress-buffs/${poolId}`),
    myRewardAssignments: () => request<{ items: MemberRewardAssignment[]; currentCycle: CurrentRewardCycle | null }>("GET", "/reward-assignments/mine"),
    kudos: (playerId: string) => request<KudosSummary>("GET", `/accounts/${playerId}/kudos`),
    myRewardEligibility: () => request<RewardEligibility>("GET", "/reward-eligibility/mine"),
    registerFortressBuff: (input: { buff: FortressBuff; quantity: number; source: string; acquiredAt?: string }) =>
      request<FortressBuffPool>("POST", "/fortress-buffs", input),
    registerFortressBuffHaul: (input: {
      quantities: Record<FortressBuff, number>;
      source: string;
      acquiredAt?: string;
    }) => request<{ items: FortressBuffPool[] }>("POST", "/fortress-buffs/bulk", input),
    buildFortressRewardPlan: () => request<{ recommendations: number; units: number; skippedUnvaluedPools: number }>("POST", "/fortress-buffs/plan-current"),
    assignFortressBuff: (poolId: string, playerId: string, amount: number) =>
      request<FortressBuffAssignmentView>("POST", `/fortress-buffs/${poolId}/assignments`, { playerId, amount }),
    confirmFortressBuffAssignment: (poolId: string, playerId: string) =>
      request<FortressBuffAssignmentView>("POST", `/fortress-buffs/${poolId}/assignments/${playerId}/confirm`),
    growth: (weeks = 12, metric: StrengthMetric = "city_power", cohort: "members" | "all" = "members") =>
      request<AllianceGrowth>("GET", `/metrics/alliance?weeks=${weeks}&metric=${metric}&cohort=${cohort}`),
    attendanceGrowth: (weeks = 12) =>
      request<AllianceAttendanceGrowth>("GET", `/metrics/alliance-attendance?weeks=${weeks}`),
    eventParticipation: (kind: EventKind, weeks = 12) =>
      request<EventParticipationMetrics>("GET", `/metrics/event-participation?kind=${kind}&weeks=${weeks}`),
    events: (from?: string) =>
      request<{ items: EventListItem[] }>("GET", `/events${from ? `?from=${encodeURIComponent(from)}` : ""}`),
    event: (eventId: string) => request<EventDetail>("GET", `/events/${eventId}`),
    createEvent: (input: NewEvent) => request<AllianceEvent>("POST", "/events", input),
    updateEvent: (eventId: string, changes: EventChanges) =>
      request<AllianceEvent>("PATCH", `/events/${eventId}`, changes),
    configureEventSession: (eventId: string, session: { id: string; label: string }) =>
      request<{ event: AllianceEvent; assignedSignups: number }>("POST", `/events/${eventId}/session`, session),
    attendance: (eventId: string, playerId: string, status: AttendanceStatus, sessionId?: string) =>
      request<{ status: AttendanceStatus }>("PUT", `/events/${eventId}/attendance/${playerId}`, {
        status,
        ...(sessionId ? { sessionId } : {}),
      }),
    reliability: (playerId: string) => request<Participation>("GET", `/accounts/${playerId}/reliability`),
    officerJobs: () => request<{ items: OfficerJob[] }>("GET", "/officer-jobs"),
    tickJob: (eventId: string, taskId: string, done: boolean) =>
      request<{ version: number; tasks: ChecklistTask[] }>("PUT", `/events/${eventId}/checklist/${taskId}`, { done }),
    svsRounds: () => request<{ items: SvsRoundListItem[] }>("GET", "/svs-rounds"),
    createSvsRound: (input: { label: string; weekStart: string }) =>
      request<SvsRoundListItem>("POST", "/svs-rounds", input),
    svsRound: (roundId: string) => request<SvsRoundDetail>("GET", `/svs-rounds/${roundId}`),
    saveBuffPreferences: (roundId: string, playerId: string, days: DayPreferenceInput[]) =>
      request<{ days: DayPreferenceInput[] }>("PUT", `/svs-rounds/${roundId}/preferences/${playerId}`, { days }),
    publishLineup: (
      eventId: string,
      sessionId: string,
      entries: { playerId: string; role: LineupRole }[],
      expectedVersion: number,
      note?: string,
    ) =>
      request<PublishedLineup>("POST", `/events/${eventId}/sessions/${sessionId}/lineup`, {
        entries,
        expectedVersion,
        ...(note ? { note } : {}),
      }),
    publishStrategy: (
      eventId: string,
      sessionId: string,
      body: string,
      assignments: { playerId: string; role: StrategyRole; duty?: string; note?: string }[],
      expectedVersion: number,
    ) =>
      request<PublishedStrategy>("POST", `/events/${eventId}/sessions/${sessionId}/strategy`, {
        body,
        assignments,
        expectedVersion,
      }),
    recordResult: (
      eventId: string,
      sessionId: string,
      input: {
        outcome: EventOutcome;
        ourScore: number;
        opponentScore: number;
        ourMatchmakingPower?: number;
        opponentMatchmakingPower?: number;
        opponentCombatants?: number;
        notes?: string;
        playerPoints: { playerId: string; points: number }[];
        expectedVersion: number;
      },
    ) => request<PublishedResult>("POST", `/events/${eventId}/sessions/${sessionId}/result`, input),
    answer: (eventId: string, playerId: string, answer: Answer, sessionId?: string) =>
      request<{ answer: Answer; sessionId?: string }>("PUT", `/events/${eventId}/answers/${playerId}`, {
        answer,
        ...(sessionId ? { sessionId } : {}),
      }),
  };
}
