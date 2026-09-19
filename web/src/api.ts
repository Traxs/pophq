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
  power: number | null;
  previousPower: number | null;
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

export type EventKind = "foundry" | "bear" | "svs" | "other";
export type Answer = "yes" | "no" | "maybe";

export interface AllianceEvent {
  eventId: string;
  alliance: string;
  kind: EventKind;
  title: string;
  startsAt: string;
  deadlineAt: string;
  notes?: string;
  createdBy: string;
}

export interface EventListItem extends AllianceEvent {
  closed: boolean;
  myAnswer: Answer | null;
}

export interface AnswerCounts {
  yes: number;
  no: number;
  maybe: number;
  pending: number;
}

export interface EventMember {
  playerId: string;
  name: string;
  rank: string | null;
  answer: Answer | null;
  answeredAt: string | null;
}

export interface EventDetail extends EventListItem {
  counts: AnswerCounts;
  /** Officers only. */
  members?: EventMember[];
}

export interface NewEvent {
  kind: EventKind;
  title: string;
  startsAt: string;
  deadlineAt?: string;
  notes?: string;
}

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
    growth: (weeks = 12, metric: StrengthMetric = "city_power", cohort: "members" | "all" = "members") =>
      request<AllianceGrowth>("GET", `/metrics/alliance?weeks=${weeks}&metric=${metric}&cohort=${cohort}`),
    events: () => request<{ items: EventListItem[] }>("GET", "/events"),
    event: (eventId: string) => request<EventDetail>("GET", `/events/${eventId}`),
    createEvent: (input: NewEvent) => request<AllianceEvent>("POST", "/events", input),
    answer: (eventId: string, playerId: string, answer: Answer) =>
      request<{ answer: Answer }>("PUT", `/events/${eventId}/answers/${playerId}`, { answer }),
  };
}
