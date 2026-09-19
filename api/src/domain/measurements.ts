import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Typed metrics. City power and combat score are different metrics and are never mixed.
 * New metrics are added here (later: from settings) without a schema change.
 */
export const HELIOS_VALUES = ["Unknown", "None", "Soon", "Infantry", "Lancer", "Marksman", "All"] as const;

type MetricDef =
  | { kind: "integer"; unit: string; min: number; max: number }
  | { kind: "decimal"; unit: string; min: number; max: number }
  | { kind: "enum"; unit: string; values: readonly string[] }
  | { kind: "level"; unit: string };

export const METRICS = {
  city_power: { kind: "integer", unit: "power", min: 0, max: 2_000_000_000 },
  hero_power_total: { kind: "integer", unit: "power", min: 0, max: 2_000_000_000 },
  // Strength comes in several kinds; each is its own metric so they are never mixed up.
  // foundry_strength is the Foundry comparison score (Hermes calls it combat_power),
  // which is not city power. Further kinds (SvS, rally) are added here as they appear.
  foundry_strength: { kind: "decimal", unit: "score", min: 0, max: 1e12 },
  troops_infantry: { kind: "integer", unit: "troops", min: 0, max: 50_000_000 },
  troops_lancer: { kind: "integer", unit: "troops", min: 0, max: 50_000_000 },
  troops_marksman: { kind: "integer", unit: "troops", min: 0, max: 50_000_000 },
  furnace_level: { kind: "level", unit: "level" },
  troop_fc_level: { kind: "level", unit: "level" },
  helios: { kind: "enum", unit: "type", values: HELIOS_VALUES },
} as const satisfies Record<string, MetricDef>;

export type MetricName = keyof typeof METRICS;
/** "date": the day is known but not the time, as with values read from a dated screenshot. */
export type Precision = "exact" | "rounded" | "date" | "unknown";
export type Source = "player" | "officer" | "hermes" | "import";

export interface MeasurementValue {
  metric: MetricName;
  value: number | string;
  unit: string;
  precision: Precision;
}

export interface Report {
  reportId: string;
  playerId: string;
  effectiveAt: string; // ISO timestamp
  recordedAt: string; // ISO timestamp
  source: Source;
  values: MeasurementValue[];
  supersedesReportId?: string;
  note?: string;
}

// Furnace levels as shown in game: 1–30, then FC1–FC10 with optional sub-steps (e.g. "FC5-2").
const LEVEL = /^(?:[1-9]|[12][0-9]|30|FC(?:[1-9]|10)(?:-[1-4])?)$/;

const TOLERANCE_MS = 5 * 60 * 1000; // server clock tolerance (FM-30)
const PLAYER_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;

const ReportInputSchema = z.object({
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  values: z
    .array(
      z.object({
        metric: z.string(),
        value: z.union([z.number(), z.string()]),
        precision: z.enum(["exact", "rounded", "unknown"]).default("exact"),
      }),
    )
    .min(1, "At least one value is required.")
    .max(Object.keys(METRICS).length),
  supersedesReportId: z.string().min(1).max(64).optional(),
  note: z.string().trim().max(500).optional(),
});

export interface ReportContext {
  playerId: string;
  reportId: string;
  source: Source;
  now: Date;
}

/** Validates and normalises a report submission. Pure: ids and time come from the caller. */
export function parseReport(input: unknown, ctx: ReportContext): Report {
  const parsed = ReportInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid report.", z.flattenError(parsed.error).fieldErrors);
  }
  const data = parsed.data;
  const nowMs = ctx.now.getTime();
  const effective = data.effectiveAt ? new Date(data.effectiveAt) : ctx.now;
  if (effective.getTime() > nowMs + TOLERANCE_MS) {
    throw new ValidationError("Effective date can't be in the future.");
  }
  if (ctx.source === "player" && effective.getTime() < nowMs - PLAYER_BACKDATE_MS) {
    throw new ValidationError("Players can backdate a report by at most 30 days.");
  }

  const seen = new Set<string>();
  const values = data.values.map((v): MeasurementValue => {
    if (!(v.metric in METRICS)) throw new ValidationError(`Unknown metric "${v.metric}".`);
    const metric = v.metric as MetricName;
    if (seen.has(metric)) throw new ValidationError(`Metric "${metric}" appears twice.`);
    seen.add(metric);
    return { metric, value: parseValue(metric, v.value), unit: METRICS[metric].unit, precision: v.precision };
  });

  const report: Report = {
    reportId: ctx.reportId,
    playerId: ctx.playerId,
    effectiveAt: effective.toISOString(),
    recordedAt: ctx.now.toISOString(),
    source: ctx.source,
    values,
  };
  if (data.supersedesReportId) report.supersedesReportId = data.supersedesReportId;
  if (data.note) report.note = data.note;
  return report;
}

function parseValue(metric: MetricName, raw: number | string): number | string {
  const def: MetricDef = METRICS[metric];
  switch (def.kind) {
    case "integer":
    case "decimal": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,_\s]/g, ""));
      if (!Number.isFinite(n)) throw new ValidationError(`${metric} must be a number.`);
      if (def.kind === "integer" && !Number.isInteger(n)) {
        throw new ValidationError(`${metric} must be a whole number.`);
      }
      if (n < def.min || n > def.max) {
        throw new ValidationError(`${metric} must be between ${def.min} and ${def.max}.`);
      }
      return n;
    }
    case "level": {
      const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
      if (!LEVEL.test(s)) throw new ValidationError(`${metric} must be 1–30 or FC1–FC10 (e.g. FC5-2).`);
      return s;
    }
    case "enum": {
      const s = String(raw).trim();
      const match = def.values.find((x) => x.toLowerCase() === s.toLowerCase());
      if (!match) throw new ValidationError(`${metric} must be one of: ${def.values.join(", ")}.`);
      return match;
    }
  }
}

export interface CurrentValue extends MeasurementValue {
  reportId: string;
  effectiveAt: string;
}

/**
 * Current value per metric: the latest non-superseded value by effectiveAt,
 * then recordedAt, then reportId (ULIDs sort by creation) as a deterministic tie-break.
 */
export function currentValues(reports: readonly Report[]): Partial<Record<MetricName, CurrentValue>> {
  const superseded = new Set(reports.flatMap((r) => (r.supersedesReportId ? [r.supersedesReportId] : [])));
  const ordered = reports
    .filter((r) => !superseded.has(r.reportId))
    .toSorted(
      (a, b) =>
        a.effectiveAt.localeCompare(b.effectiveAt) ||
        a.recordedAt.localeCompare(b.recordedAt) ||
        a.reportId.localeCompare(b.reportId),
    );
  const out: Partial<Record<MetricName, CurrentValue>> = {};
  for (const r of ordered) {
    for (const v of r.values) out[v.metric] = { ...v, reportId: r.reportId, effectiveAt: r.effectiveAt };
  }
  return out;
}
