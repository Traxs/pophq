import { z } from "zod";
import type { Repository } from "../data/repository.js";
import type { GameAccount } from "../domain/accounts.js";
import { canonicalJson } from "../domain/agentTokens.js";
import { ValidationError } from "../domain/errors.js";
import type { HistoricalRecord } from "../domain/historicalRecords.js";
import { parseGameName, parsePlayerId, searchKey } from "../domain/identity.js";

const BatchId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/);
const SourceText = z.string().trim().min(1).max(200);
const HistoricalSpreadsheetEvidence = z.object({
  row: z.number().int().positive(),
  name: z.unknown(),
  status: z.string().trim().min(1).max(40),
});
const SourceCorrection = z.object({
  observed: z.unknown(),
  correctedTo: z.unknown(),
  status: z.string().trim().min(1).max(60),
});
const Entry = z.object({
  sourceId: SourceText.optional(),
  playerId: z.union([z.string(), z.number()]).nullable().optional(),
  name: z.unknown(),
  sourceScoreName: z.unknown().optional(),
  pendingCastleBattlePoints: z.number().int().nonnegative().optional(),
  identityEvidence: z.string().trim().min(1).max(80),
  historicalSpreadsheetEvidence: HistoricalSpreadsheetEvidence.nullable().optional(),
  sourceCorrections: z.array(SourceCorrection).max(5).optional(),
});
const Batch = z.object({
  batchId: BatchId,
  alliance: z.literal("POP").default("POP"),
  eventId: z.string().trim().min(3).max(80).optional(),
  phaseKey: z.enum(["preparation", "castle_battle"]).optional(),
  // Nineteen is the largest batch that still fits DynamoDB's 100-operation atomic
  // transaction in the worst case (account + alias/audit + two evidence records + receipt).
  entries: z.array(Entry).min(1).max(19),
});

export interface AccountOnboardingEntry {
  sourceId: string;
  playerId: string | null;
  name: string;
  sourceScoreName?: string;
  pendingCastleBattlePoints?: number;
  identityEvidence: string;
  historicalSpreadsheetEvidence?: { row: number; name: string; status: string };
  sourceCorrections?: { observed: string; correctedTo: string; status: string }[];
}

export interface AccountOnboardingBatch {
  batchId: string;
  alliance: "POP";
  eventId?: string;
  phaseKey?: "preparation" | "castle_battle";
  entries: AccountOnboardingEntry[];
}

export type AccountOnboardingDecision = "create_shell" | "reuse_exact" | "preserve_unresolved" | "conflict";

export interface AccountOnboardingRow {
  sourceId: string;
  playerId: string | null;
  suppliedName: string;
  decision: AccountOnboardingDecision;
  before: GameAccount | null;
  after: GameAccount | null;
  hasLogin: boolean;
  aliasAdditions: string[];
  evidenceAdditions: HistoricalRecord[];
  unchangedEvidence: string[];
  issues: string[];
}

export interface AccountOnboardingPlan {
  batchId: string;
  alliance: "POP";
  rows: AccountOnboardingRow[];
  counts: {
    create: number;
    reuse: number;
    unresolved: number;
    conflicts: number;
    aliasesToAdd: number;
    evidenceToAdd: number;
  };
  effects: {
    createsLogin: false;
    sendsInvite: false;
    sendsEmail: false;
    createsCredentials: false;
    linksHumanOwner: false;
    infersMainAltOwnership: false;
    changesMembership: false;
    writesScores: false;
  };
  applicable: boolean;
  writes: {
    accounts: GameAccount[];
    expectedAccounts: GameAccount[];
    aliases: { playerId: string; name: string; justification: string }[];
    evidence: HistoricalRecord[];
  };
}

export function parseAccountOnboardingBatch(input: unknown): AccountOnboardingBatch {
  const parsed = Batch.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid account-onboarding batch.", z.flattenError(parsed.error).fieldErrors);
  const entries = parsed.data.entries.map((entry, index): AccountOnboardingEntry => {
    const playerId = entry.playerId === null || entry.playerId === undefined ? null : parsePlayerId(entry.playerId);
    const name = parseGameName(entry.name);
    const sourceScoreName = entry.sourceScoreName === undefined ? undefined : parseGameName(entry.sourceScoreName);
    const historical = entry.historicalSpreadsheetEvidence
      ? {
          row: entry.historicalSpreadsheetEvidence.row,
          name: parseGameName(entry.historicalSpreadsheetEvidence.name),
          status: entry.historicalSpreadsheetEvidence.status,
        }
      : undefined;
    const sourceCorrections = entry.sourceCorrections?.map((correction) => ({
      observed: parseGameName(correction.observed),
      correctedTo: parseGameName(correction.correctedTo),
      status: correction.status,
    }));
    return {
      sourceId: entry.sourceId ?? `${parsed.data.batchId}:row-${index + 1}`,
      playerId,
      name,
      ...(sourceScoreName ? { sourceScoreName } : {}),
      ...(entry.pendingCastleBattlePoints !== undefined ? { pendingCastleBattlePoints: entry.pendingCastleBattlePoints } : {}),
      identityEvidence: entry.identityEvidence,
      ...(historical ? { historicalSpreadsheetEvidence: historical } : {}),
      ...(sourceCorrections?.length ? { sourceCorrections } : {}),
    };
  });
  return {
    batchId: parsed.data.batchId,
    alliance: parsed.data.alliance,
    ...(parsed.data.eventId ? { eventId: parsed.data.eventId } : {}),
    ...(parsed.data.phaseKey ? { phaseKey: parsed.data.phaseKey } : {}),
    entries,
  };
}

const recordId = (batchId: string, playerId: string | null, sourceId: string, suffix: string) =>
  `account-shell:${batchId}:${playerId ?? `unresolved-${sourceId.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`}:${suffix}`.slice(0, 200);

function identityRecord(batch: AccountOnboardingBatch, entry: AccountOnboardingEntry): HistoricalRecord {
  return {
    recordId: recordId(batch.batchId, entry.playerId, entry.sourceId, "identity"),
    category: "evidence",
    sourceId: entry.sourceId,
    payload: {
      kind: "account_identity_binding",
      suppliedName: entry.name,
      sourceScoreName: entry.sourceScoreName ?? null,
      identityEvidence: entry.identityEvidence,
      pendingCastleBattlePoints: entry.pendingCastleBattlePoints ?? null,
      eventId: batch.eventId ?? null,
      phaseKey: batch.phaseKey ?? null,
      resolution: entry.playerId ? "exact_player_id" : "unresolved_without_player_id",
      noLoginOrInvitationCreated: true,
      sourceCorrections: entry.sourceCorrections ?? [],
    },
    ...(entry.playerId ? { playerId: entry.playerId } : {}),
    ...(batch.eventId ? { eventId: batch.eventId } : {}),
    reviewStatus: entry.playerId ? "approved_exact_id" : "unresolved",
  };
}

function historicalNameRecord(batch: AccountOnboardingBatch, entry: AccountOnboardingEntry): HistoricalRecord | undefined {
  const historical = entry.historicalSpreadsheetEvidence;
  if (!entry.playerId || !historical) return undefined;
  return {
    recordId: recordId(batch.batchId, entry.playerId, entry.sourceId, `spreadsheet-row-${historical.row}`),
    category: "alias",
    sourceId: entry.sourceId,
    playerId: entry.playerId,
    payload: { name: historical.name, row: historical.row, status: historical.status },
    reviewStatus: historical.status,
  };
}

/**
 * Builds an exhaustive, non-mutating reconciliation plan. Exact Player IDs are the only account
 * match key; names are used solely for conflict and alias checks.
 */
export async function planAccountOnboarding(repo: Repository, batch: AccountOnboardingBatch): Promise<AccountOnboardingPlan> {
  const accounts = await repo.listAccounts(batch.alliance);
  const accountsById = new Map(accounts.map((account) => [account.playerId, account]));
  const aliasesById = new Map(await Promise.all(accounts.map(async (account) => [account.playerId, await repo.listAliases(account.playerId)] as const)));
  const claims = new Map<string, Set<string>>();
  for (const account of accounts) {
    for (const name of [account.name, ...(aliasesById.get(account.playerId) ?? []).map((alias) => alias.name)]) {
      const key = searchKey(name);
      const ids = claims.get(key) ?? new Set<string>();
      ids.add(account.playerId);
      claims.set(key, ids);
    }
  }
  const [evidenceRecords, aliasRecords] = await Promise.all([
    repo.listHistoricalRecords("evidence"),
    repo.listHistoricalRecords("alias"),
  ]);
  const records = new Map([...evidenceRecords, ...aliasRecords].map((record) => [`${record.category}:${record.recordId}`, record]));
  const duplicateIds = new Set(
    batch.entries.flatMap((entry, index) => entry.playerId && batch.entries.findIndex((candidate) => candidate.playerId === entry.playerId) !== index ? [entry.playerId] : []),
  );
  const rows: AccountOnboardingRow[] = [];
  const writes: AccountOnboardingPlan["writes"] = { accounts: [], expectedAccounts: [], aliases: [], evidence: [] };

  for (const entry of batch.entries) {
    const existing = entry.playerId ? (accountsById.get(entry.playerId) ?? await repo.getAccount(entry.playerId)) : undefined;
    const currentAliases = entry.playerId ? (aliasesById.get(entry.playerId) ?? await repo.listAliases(entry.playerId)) : [];
    const aliasKeys = new Set(currentAliases.map((alias) => searchKey(alias.name)));
    const issues: string[] = [];
    if (entry.playerId && duplicateIds.has(entry.playerId)) issues.push("Player ID appears more than once in this batch.");
    if (existing && existing.alliance !== batch.alliance) issues.push(`Player ID already belongs to ${existing.alliance}, not ${batch.alliance}.`);
    if (existing && searchKey(existing.name) !== searchKey(entry.name) && !aliasKeys.has(searchKey(entry.name))) {
      issues.push(`Existing canonical name is ${existing.name}; ${entry.name} is not a recorded alias.`);
    }
    if (entry.playerId) {
      const canonicalClaims = claims.get(searchKey(entry.name));
      if (canonicalClaims && [...canonicalClaims].some((id) => id !== entry.playerId)) {
        issues.push(`Name ${entry.name} is already attached to another Player ID.`);
      }
    }

    const desiredRecords = [identityRecord(batch, entry), historicalNameRecord(batch, entry)].filter((record): record is HistoricalRecord => Boolean(record));
    const evidenceAdditions: HistoricalRecord[] = [];
    const unchangedEvidence: string[] = [];
    for (const desired of desiredRecords) {
      const current = records.get(`${desired.category}:${desired.recordId}`);
      if (!current) evidenceAdditions.push(desired);
      else if (canonicalJson(current) === canonicalJson(desired)) unchangedEvidence.push(desired.recordId);
      else issues.push(`Source record ${desired.recordId} already exists with different evidence.`);
    }

    const aliasAdditions: string[] = [];
    const historicalName = entry.historicalSpreadsheetEvidence?.name;
    if (entry.playerId && historicalName && searchKey(historicalName) !== searchKey(existing?.name ?? entry.name)) {
      const otherClaims = claims.get(searchKey(historicalName));
      if (otherClaims && [...otherClaims].some((id) => id !== entry.playerId)) {
        issues.push(`Historical name ${historicalName} is already attached to another Player ID.`);
      } else if (!aliasKeys.has(searchKey(historicalName))) {
        aliasAdditions.push(historicalName);
      }
    }

    const after: GameAccount | null = entry.playerId
      ? existing ?? { playerId: entry.playerId, name: entry.name, alliance: batch.alliance, status: "unknown" }
      : null;
    const hasLogin = entry.playerId ? Boolean(await repo.linkedLoginAccess(entry.playerId)) : false;
    const decision: AccountOnboardingDecision = issues.length > 0
      ? "conflict"
      : !entry.playerId
        ? "preserve_unresolved"
        : existing
          ? "reuse_exact"
          : "create_shell";
    const row: AccountOnboardingRow = {
      sourceId: entry.sourceId,
      playerId: entry.playerId,
      suppliedName: entry.name,
      decision,
      before: existing ?? null,
      after,
      hasLogin,
      aliasAdditions,
      evidenceAdditions,
      unchangedEvidence,
      issues,
    };
    rows.push(row);
    if (decision !== "conflict") {
      if (decision === "create_shell" && after) writes.accounts.push(after);
      if (decision === "reuse_exact" && existing) writes.expectedAccounts.push(existing);
      writes.aliases.push(...aliasAdditions.map((name) => ({
        playerId: entry.playerId!,
        name,
        justification: `Source-backed historical name from account-onboarding batch ${batch.batchId}.`,
      })));
      writes.evidence.push(...evidenceAdditions);
    }
  }

  const counts = {
    create: rows.filter((row) => row.decision === "create_shell").length,
    reuse: rows.filter((row) => row.decision === "reuse_exact").length,
    unresolved: rows.filter((row) => row.decision === "preserve_unresolved").length,
    conflicts: rows.filter((row) => row.decision === "conflict").length,
    aliasesToAdd: writes.aliases.length,
    evidenceToAdd: writes.evidence.length,
  };
  return {
    batchId: batch.batchId,
    alliance: batch.alliance,
    rows,
    counts,
    effects: {
      createsLogin: false,
      sendsInvite: false,
      sendsEmail: false,
      createsCredentials: false,
      linksHumanOwner: false,
      infersMainAltOwnership: false,
      changesMembership: false,
      writesScores: false,
    },
    applicable: counts.conflicts === 0,
    writes,
  };
}
