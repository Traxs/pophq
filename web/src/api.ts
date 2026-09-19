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
  };
}
