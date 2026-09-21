// Typed client for the parts of /v1 this page uses. Will be generated from OpenAPI later.

export interface GameAccount {
  playerId: string;
  name: string;
  alliance: string;
  rank?: string;
  status: string;
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
  /** Six trailing months, oldest first; null for a month with nothing to say. */
  powerTrend: (number | null)[];
  strengthTrend: (number | null)[];
  attendanceTrend: (number | null)[];
  power: number | null;
  previousPower: number | null;
  foundryStrength: number | null;
  attendance: Reliability;
  /** The latest Foundry-strength report; separate from the city-power report date below. */
  lastFoundryReportAt: string | null;
  /** The latest city-power report. */
  lastReportAt: string | null;
  furnace: string | null;
  reports: number;
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
  seats: Seats;
}

export type AgentScope = "all:read" | "results:read" | "results:write" | "events:write" | "history:write";
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

export interface Reliability {
  rate?: number;
  kept: number;
  missed: number;
  excused: number;
  sample: number;
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

export interface EventDetail extends Omit<EventListItem, "sessions"> {
  sessions: SessionView[];
  counts: AnswerCounts;
  /** Starting text for a new strategy, inherited from the event type. */
  strategyTemplate?: string;
  /** Officers only. */
  members?: EventMember[];
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
    agentTokens: () => request<{ items: AgentTokenInfo[] }>("GET", "/agent-tokens"),
    issueAgentToken: (input: { name: string; scopes: AgentScope[]; expiresInDays: number }) =>
      request<IssuedAgentToken>("POST", "/agent-tokens", input),
    revokeAgentToken: (tokenId: string) => request<{ revoked: true }>("DELETE", `/agent-tokens/${tokenId}`),
    growth: (weeks = 12, metric: StrengthMetric = "city_power", cohort: "members" | "all" = "members") =>
      request<AllianceGrowth>("GET", `/metrics/alliance?weeks=${weeks}&metric=${metric}&cohort=${cohort}`),
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
    reliability: (playerId: string) => request<Reliability>("GET", `/accounts/${playerId}/reliability`),
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
