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
