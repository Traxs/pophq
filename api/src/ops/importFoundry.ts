// Imports a Hermes export bundle (LCH-04): game accounts and their strength observations.
// Rules that keep the import honest:
//   - accounts without a numeric Player ID are reported, never invented;
//   - membership is "unknown" unless POP HQ already knows the account: a dated snapshot from
//     another system does not prove who is in the alliance today;
//   - every observation keeps its own observed date, precision and source, and gets a stable
//     id derived from the bundle, so importing twice changes nothing;
//   - an account POP HQ already has keeps its name and rank; the import never renames people.
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import type { GameAccount } from "../domain/accounts.js";
import type { AllianceEvent } from "../domain/events.js";
import { parseGameName, parsePlayerId } from "../domain/identity.js";
import type { MetricName, Precision, Report } from "../domain/measurements.js";

export interface BundlePlayer {
  id: string;
  canonical_name?: string | null;
  display_name?: string | null;
  game_player_id?: string | null;
}

export interface BundleObservation {
  id: string;
  player_id: string;
  metric: string;
  unit?: string | null;
  value: number;
  observed_at: string;
  precision?: string | null;
  recorded_at?: string | null;
  source_type?: string | null;
  evidence_id?: string | null;
  review_status?: string | null;
}

/** Hermes' metric names mapped to ours; anything else is reported, not guessed. */
export const METRIC_MAP: Record<string, MetricName> = {
  combat_power: "foundry_strength",
  city_power: "city_power",
  hero_power: "hero_power_total",
};

const PRECISION_MAP: Record<string, Precision> = {
  date: "date",
  exact: "exact",
  rounded: "rounded",
};

export interface PlannedAccount {
  playerId: string;
  name: string;
  bundleId: string;
}

export interface PlannedReport {
  reportId: string;
  playerId: string;
  metric: MetricName;
  value: number;
  effectiveAt: string;
  recordedAt: string;
  precision: Precision;
  note: string;
}

export interface ImportPlan {
  accounts: PlannedAccount[];
  reports: PlannedReport[];
  /** Bundle accounts with no numeric Player ID; an officer has to supply one. */
  withoutPlayerId: { bundleId: string; name: string }[];
  /** Observations that could not be used, with the reason. */
  skipped: { id: string; reason: string }[];
}

const dayStart = (date: string): string => `${date.slice(0, 10)}T00:00:00.000Z`;

/** Decides what an import would do, without touching the database. */
export function planImport(players: readonly BundlePlayer[], observations: readonly BundleObservation[]): ImportPlan {
  const plan: ImportPlan = { accounts: [], reports: [], withoutPlayerId: [], skipped: [] };
  const playerIdOf = new Map<string, string>();

  for (const player of players) {
    const rawName = player.canonical_name ?? player.display_name ?? "";
    let name: string;
    try {
      name = parseGameName(rawName);
    } catch {
      plan.skipped.push({ id: player.id, reason: `unusable name ${JSON.stringify(rawName)}` });
      continue;
    }
    if (!player.game_player_id) {
      plan.withoutPlayerId.push({ bundleId: player.id, name });
      continue;
    }
    try {
      const playerId = parsePlayerId(player.game_player_id);
      playerIdOf.set(player.id, playerId);
      plan.accounts.push({ playerId, name, bundleId: player.id });
    } catch {
      plan.skipped.push({ id: player.id, reason: `invalid Player ID ${JSON.stringify(player.game_player_id)}` });
    }
  }

  for (const observation of observations) {
    const playerId = playerIdOf.get(observation.player_id);
    if (!playerId) {
      plan.skipped.push({ id: observation.id, reason: "no account with a Player ID" });
      continue;
    }
    const metric = METRIC_MAP[observation.metric];
    if (!metric) {
      plan.skipped.push({ id: observation.id, reason: `unknown metric ${observation.metric}` });
      continue;
    }
    if (typeof observation.value !== "number" || !Number.isFinite(observation.value)) {
      plan.skipped.push({ id: observation.id, reason: "value is not a number" });
      continue;
    }
    const effectiveAt = dayStart(observation.observed_at);
    plan.reports.push({
      // Stable id from the bundle: a second import writes the same records, not duplicates.
      reportId: `IMPORT-${observation.id}`.slice(0, 120),
      playerId,
      metric,
      value: observation.value,
      effectiveAt,
      recordedAt: observation.recorded_at ?? effectiveAt,
      precision: PRECISION_MAP[observation.precision ?? ""] ?? "unknown",
      note: [observation.source_type, observation.review_status, observation.evidence_id && `evidence ${observation.evidence_id}`]
        .filter(Boolean)
        .join(", "),
    });
  }

  return plan;
}

export interface ImportResult {
  accountsCreated: number;
  accountsKept: number;
  reportsWritten: number;
  reportsAlreadyThere: number;
  withoutPlayerId: number;
  skipped: number;
}

/** Applies a plan. Existing accounts and already-imported observations are left as they are. */
export async function applyImport(repo: Repository, plan: ImportPlan, actor: Actor): Promise<ImportResult> {
  const result: ImportResult = {
    accountsCreated: 0,
    accountsKept: 0,
    reportsWritten: 0,
    reportsAlreadyThere: 0,
    withoutPlayerId: plan.withoutPlayerId.length,
    skipped: plan.skipped.length,
  };

  for (const account of plan.accounts) {
    const existing = await repo.getAccount(account.playerId);
    if (existing) {
      result.accountsKept += 1;
      continue;
    }
    const imported: GameAccount = {
      playerId: account.playerId,
      name: account.name,
      alliance: "POP",
      // Another system's snapshot is not proof of membership today (bundle: membership model).
      status: "unknown",
    };
    await repo.createAccount(imported, actor);
    result.accountsCreated += 1;
  }

  for (const planned of plan.reports) {
    const report: Report = {
      reportId: planned.reportId,
      playerId: planned.playerId,
      effectiveAt: planned.effectiveAt,
      recordedAt: planned.recordedAt,
      source: "import",
      values: [
        {
          metric: planned.metric,
          value: planned.value,
          unit: planned.metric === "foundry_strength" ? "score" : "power",
          precision: planned.precision,
        },
      ],
      ...(planned.note ? { note: planned.note } : {}),
    };
    try {
      await repo.addReport(report, actor);
      result.reportsWritten += 1;
    } catch (err) {
      // Already imported (same id) or the account may not receive data: both are fine here.
      if (err instanceof Error && /already|conflict|can't|not found/i.test(err.message)) {
        result.reportsAlreadyThere += 1;
        continue;
      }
      throw err;
    }
  }

  return result;
}

// ---- Events, attendance and sign-ups (LCH-04, second part) ----

export interface BundleEvent {
  id: string;
  event_type: string;
  event_date: string;
  legion?: number | null;
  time_utc?: string | null;
  status?: string | null;
  notes?: string | null;
}

export interface BundleAttendance {
  id: string;
  event_id: string;
  player_id: string;
  status: string;
  source_type?: string | null;
  evidence_id?: string | null;
  confidence?: number | null;
  note?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface BundleSignup {
  id: string;
  player_id?: string | null;
  event_id?: string | null;
  preferred_legion?: number | null;
  preference_status?: string | null;
}

/** Hermes records one row per legion; POP HQ keeps one event per day with a part per legion. */
export interface PlannedEvent {
  eventId: string;
  title: string;
  startsAt: string;
  deadlineAt: string;
  notes?: string;
  sessions: { id: string; label: string; startsAt: string; starters: number; subs: number }[];
  /** Bundle rows this event was built from, so attendance and sign-ups can be attached. */
  sourceIds: Record<string, string>;
}

export interface PlannedAttendance {
  eventId: string;
  playerId: string;
  sessionId?: string;
  status: "present" | "absent" | "excused" | "unknown";
  source: "officer" | "screenshot" | "import";
  recordedAt: string;
  note?: string;
  evidenceRef?: string;
}

export interface PlannedSignUp {
  eventId: string;
  playerId: string;
  sessionId: string;
}

export interface EventImportPlan {
  events: PlannedEvent[];
  attendance: PlannedAttendance[];
  signUps: PlannedSignUp[];
  skipped: { id: string; reason: string }[];
}

const STATUS_MAP: Record<string, PlannedAttendance["status"]> = {
  present: "present",
  absent: "absent",
  excused: "excused",
  unknown: "unknown",
};

const SOURCE_MAP: Record<string, PlannedAttendance["source"]> = {
  screenshot_extracted: "screenshot",
  owner_reported: "officer",
};

/** Foundry capacity, as POP plays it. */
const STARTERS = 30;
const SUBS = 10;

export function planEventImport(
  players: readonly BundlePlayer[],
  events: readonly BundleEvent[],
  attendance: readonly BundleAttendance[],
  signUps: readonly BundleSignup[],
): EventImportPlan {
  const plan: EventImportPlan = { events: [], attendance: [], signUps: [], skipped: [] };
  const playerIdOf = new Map<string, string>();
  for (const player of players) {
    if (!player.game_player_id) continue;
    try {
      playerIdOf.set(player.id, parsePlayerId(player.game_player_id));
    } catch {
      /* reported by planImport; ignored here */
    }
  }

  // One event per type and day; each legion becomes a part of it.
  const byDay = new Map<string, BundleEvent[]>();
  for (const event of events) {
    const key = `${event.event_type}-${event.event_date}`;
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }

  const eventOfSource = new Map<string, { eventId: string; sessionId: string }>();
  for (const [key, rows] of byDay) {
    const date = rows[0]!.event_date;
    const sessions = rows
      .toSorted((a, b) => (a.legion ?? 0) - (b.legion ?? 0))
      .map((row) => ({
        id: `L${row.legion ?? 1}`,
        label: `Legion ${row.legion ?? 1}`,
        startsAt: `${date}T${(row.time_utc ?? "12:00").padStart(5, "0")}:00.000Z`,
        starters: STARTERS,
        subs: SUBS,
      }));
    const startsAt = sessions.map((s) => s.startsAt).toSorted()[0]!;
    const eventId = `IMPORT-${key}`;
    // The bundle's notes are Hermes' own working log, with internal file paths; they are
    // provenance, not something to show the alliance. The history keeps where data came from.
    const notes = undefined;
    plan.events.push({
      eventId,
      title: rows[0]!.event_type === "foundry" ? "Foundry" : rows[0]!.event_type,
      startsAt,
      // Answers closed three days before, as POP runs it.
      deadlineAt: `${new Date(Date.parse(startsAt) - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T23:59:59.999Z`,
      ...(notes === undefined ? {} : { notes }),
      sessions,
      sourceIds: Object.fromEntries(rows.map((r) => [r.id, `L${r.legion ?? 1}`])),
    });
    for (const row of rows) eventOfSource.set(row.id, { eventId, sessionId: `L${row.legion ?? 1}` });
  }

  for (const record of attendance) {
    const target = eventOfSource.get(record.event_id);
    const playerId = playerIdOf.get(record.player_id);
    const status = STATUS_MAP[record.status];
    if (!target || !playerId || !status) {
      plan.skipped.push({
        id: record.id,
        reason: !target ? "unknown event" : !playerId ? "no account with a Player ID" : `unknown status ${record.status}`,
      });
      continue;
    }
    plan.attendance.push({
      eventId: target.eventId,
      playerId,
      sessionId: target.sessionId,
      status,
      source: SOURCE_MAP[record.source_type ?? ""] ?? "import",
      recordedAt: record.updated_at ?? record.created_at ?? new Date().toISOString(),
      ...(record.note ? { note: record.note } : {}),
      ...(record.evidence_id ? { evidenceRef: record.evidence_id } : {}),
    });
  }

  for (const signUp of signUps) {
    const target = signUp.event_id ? eventOfSource.get(signUp.event_id) : undefined;
    const playerId = signUp.player_id ? playerIdOf.get(signUp.player_id) : undefined;
    const sessionId = signUp.preferred_legion ? `L${signUp.preferred_legion}` : target?.sessionId;
    // A sign-up only means something with a known person, a known event and a chosen legion.
    if (!target || !playerId || !sessionId) {
      plan.skipped.push({
        id: signUp.id,
        reason: !target ? "unknown event" : !playerId ? "no account with a Player ID" : "no legion chosen",
      });
      continue;
    }
    plan.signUps.push({ eventId: target.eventId, playerId, sessionId });
  }

  return plan;
}

export interface EventImportResult {
  eventsCreated: number;
  eventsKept: number;
  attendanceWritten: number;
  signUpsWritten: number;
  signUpsRefused: number;
  skipped: number;
}

/**
 * Writes the planned events, attendance and sign-ups. Events that already exist are kept as
 * they are; attendance is written as recorded, with its own date and source. Sign-ups for an
 * event that has already started are refused by the database and counted, not forced.
 */
export async function applyEventImport(repo: Repository, plan: EventImportPlan, actor: Actor): Promise<EventImportResult> {
  const result: EventImportResult = {
    eventsCreated: 0,
    eventsKept: 0,
    attendanceWritten: 0,
    signUpsWritten: 0,
    signUpsRefused: 0,
    skipped: plan.skipped.length,
  };

  const events = new Map<string, AllianceEvent>();
  for (const planned of plan.events) {
    const existing = await repo.getEvent(planned.eventId);
    if (existing) {
      events.set(planned.eventId, existing);
      result.eventsKept += 1;
      continue;
    }
    const event: AllianceEvent = {
      eventId: planned.eventId,
      alliance: "POP",
      kind: "foundry",
      title: planned.title,
      startsAt: planned.startsAt,
      deadlineAt: planned.deadlineAt,
      ...(planned.notes ? { notes: planned.notes } : {}),
      sessions: planned.sessions,
      createdBy: actor.id,
    };
    await repo.createEvent(event, actor);
    events.set(event.eventId, event);
    result.eventsCreated += 1;
  }

  for (const record of plan.attendance) {
    await repo.setAttendance(
      {
        eventId: record.eventId,
        playerId: record.playerId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        status: record.status,
        source: record.source,
        ...(record.note ? { note: record.note } : {}),
        ...(record.evidenceRef ? { evidenceRef: record.evidenceRef } : {}),
      },
      actor,
      record.recordedAt,
    );
    result.attendanceWritten += 1;
  }

  for (const signUp of plan.signUps) {
    const event = events.get(signUp.eventId);
    if (!event) continue;
    try {
      await repo.setAnswer(
        event,
        signUp.playerId,
        { answer: "yes", sessionId: signUp.sessionId },
        "officer",
        actor,
        undefined,
        { afterDeadline: true },
      );
      result.signUpsWritten += 1;
    } catch {
      // The event already started, or the account may not receive data.
      result.signUpsRefused += 1;
    }
  }

  return result;
}
