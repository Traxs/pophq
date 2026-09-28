import type { AllianceBattleScore, ResultScorePrecision } from "./api";
import { full } from "./format";

/** Never expands a rounded source label into fabricated exact points. */
export function allianceScoreText(row: AllianceBattleScore): string {
  return row.precision.kind === "rounded" ? `≈ ${row.precision.display}` : full(row.score);
}

export function playerScoreText(row: { points: number; precision?: ResultScorePrecision }): string {
  return row.precision?.kind === "rounded" ? `≈ ${row.precision.display}` : full(row.points);
}

export function rankedAllianceScores(rows: readonly AllianceBattleScore[]): AllianceBattleScore[] {
  return rows.toSorted((a, b) => b.score - a.score);
}
