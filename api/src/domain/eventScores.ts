import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { EventKind } from "./events.js";
import { parsePlayerId } from "./identity.js";

export const EVENT_SCORE_PHASES = [
  { key: "preparation", label: "Preparation phase" },
  { key: "castle_battle", label: "Castle battle phase" },
] as const;

export type EventScorePhaseKey = (typeof EVENT_SCORE_PHASES)[number]["key"];
export type EventScoreCoverage = "partial" | "complete";

export interface ScoreProvenance {
  sourceName?: string;
  displayName?: string;
  suppliedLabel?: string;
}

export interface EventScorePoint {
  playerId: string;
  points: number;
  provenance?: ScoreProvenance;
}

export interface EventPhaseScores {
  eventId: string;
  phaseKey: EventScorePhaseKey;
  phaseLabel: string;
  version: number;
  coverage: EventScoreCoverage;
  playerPoints: EventScorePoint[];
  source: { type: string; reference?: string };
  recordedAt: string;
  recordedBy: string;
}

const Points = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Provenance = z.object({
  sourceName: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  suppliedLabel: z.string().trim().min(1).max(180).optional(),
}).strict();
const Point = z.object({
  playerId: z.union([z.string(), z.number()]).transform(parsePlayerId),
  points: Points,
  provenance: Provenance.optional(),
}).strict();

export function phasesForEvent(kind: EventKind): readonly (typeof EVENT_SCORE_PHASES)[number][] {
  return kind === "svs" || kind === "koi" ? EVENT_SCORE_PHASES : [];
}

export function scorePhaseFor(kind: EventKind, raw: unknown): (typeof EVENT_SCORE_PHASES)[number] {
  const phase = phasesForEvent(kind).find((candidate) => candidate.key === raw);
  if (!phase) throw new ValidationError("That scoring phase is not configured for this event.");
  return phase;
}

export function parseSelfScore(input: unknown): { points: number } {
  const parsed = z.object({ points: Points }).strict().safeParse(input);
  if (!parsed.success) throw new ValidationError("Enter a whole-number score.", z.flattenError(parsed.error).fieldErrors);
  return parsed.data;
}

export interface PhaseScoreUpsert {
  expectedVersion: number;
  coverage: EventScoreCoverage;
  playerPoints: EventScorePoint[];
  source: { type: string; reference?: string };
}

export function parsePhaseScoreUpsert(input: unknown): PhaseScoreUpsert {
  const parsed = z.object({
    expectedVersion: z.number().int().nonnegative(),
    coverage: z.enum(["partial", "complete"]),
    playerPoints: z.array(Point).min(1).max(500),
    source: z.object({ type: z.string().trim().min(2).max(60), reference: z.string().trim().min(1).max(300).optional() }).strict(),
    reason: z.string().optional(),
    expectedHash: z.string().optional(),
    approved: z.boolean().optional(),
  }).strict().safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid phase-score request.", z.flattenError(parsed.error).fieldErrors);
  const players = parsed.data.playerPoints.map((row) => row.playerId);
  const duplicates = [...new Set(players.filter((playerId, index) => players.indexOf(playerId) !== index))];
  if (duplicates.length > 0) throw new ValidationError("Each Player ID may appear only once.", { duplicatePlayerIds: duplicates });
  return {
    expectedVersion: parsed.data.expectedVersion,
    coverage: parsed.data.coverage,
    playerPoints: parsed.data.playerPoints.map((row) => ({
      playerId: row.playerId,
      points: row.points,
      ...(row.provenance ? { provenance: Object.fromEntries(Object.entries(row.provenance).filter(([, value]) => value !== undefined)) as ScoreProvenance } : {}),
    })),
    source: { type: parsed.data.source.type, ...(parsed.data.source.reference ? { reference: parsed.data.source.reference } : {}) },
  };
}

export function upsertPhaseScores(
  current: EventPhaseScores | undefined,
  input: PhaseScoreUpsert,
  context: { eventId: string; phaseKey: EventScorePhaseKey; phaseLabel: string; recordedAt: string; recordedBy: string },
): EventPhaseScores {
  const merged = new Map((current?.playerPoints ?? []).map((row) => [row.playerId, row]));
  for (const row of input.playerPoints) merged.set(row.playerId, row);
  return {
    ...context,
    version: (current?.version ?? 0) + 1,
    coverage: input.coverage,
    playerPoints: [...merged.values()].toSorted((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId)),
    source: input.source,
  };
}

export function scoreSubtotal(rows: readonly EventScorePoint[]): number {
  return rows.reduce((sum, row) => sum + row.points, 0);
}

export function phaseScoreCounts(before: readonly EventScorePoint[], after: readonly EventScorePoint[]) {
  const old = new Map(before.map((row) => [row.playerId, row]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const row of after) {
    const prior = old.get(row.playerId);
    if (!prior) added += 1;
    else if (prior.points === row.points && JSON.stringify(prior.provenance ?? null) === JSON.stringify(row.provenance ?? null)) unchanged += 1;
    else changed += 1;
  }
  return { added, changed, unchanged };
}
