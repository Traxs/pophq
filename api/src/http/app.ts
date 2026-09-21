import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { parseNewAccount } from "../domain/accounts.js";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../domain/errors.js";
import { parseAttendance, reliabilityOf } from "../domain/attendance.js";
import {
  EVENT_KINDS,
  configureLegacySession,
  countAnswers,
  isClosed,
  parseAgentEventChanges,
  parseAgentNewEvent,
  parseAnswerChoice,
  parseEventChanges,
  parseNewEvent,
  rankSignUps,
  standingFor,
  type EventKind,
} from "../domain/events.js";
import { parseEventType, STARTER_TYPES } from "../domain/eventTypes.js";
import { parseLineup, placeIn } from "../domain/lineups.js";
import { kudosScore, parseKudos } from "../domain/kudos.js";
import {
  dayEndsAt,
  parseNewRound,
  parsePreferences,
  roundState,
  slotStartsAt,
  SLOTS_PER_DAY,
} from "../domain/svs.js";
import { parseStrategy } from "../domain/strategy.js";
import { parseEventResult } from "../domain/results.js";
import { canonicalJson, issueAgentToken } from "../domain/agentTokens.js";
import { HISTORICAL_CATEGORIES, parseHistoricalRecord, type HistoricalCategory } from "../domain/historicalRecords.js";
import { authenticateAgent, effectiveBotScopes, publicAgentToken, type BotIssuerGroups } from "./agentAuth.js";
import { listEventTypes } from "../ops/eventTypes.js";
import { parsePlayerId } from "../domain/identity.js";
import { allianceGrowth, buckets, currentOf, seriesOf } from "../domain/metrics.js";
import { monthlyAttendance, monthlyValues, trailingAverage } from "../domain/trends.js";
import { currentValues, parseImportedReport, parseReport } from "../domain/measurements.js";
import {
  defaultActing,
  isOfficer,
  parseGroups,
  requireCanWriteFor,
  requireOfficer,
  resolveActingAccount,
  type Principal,
} from "../domain/principal.js";
import type { HistoryStore } from "../data/history.js";
import type { Repository } from "../data/repository.js";
import type { Actor } from "../data/meta.js";
import { invite, type LoginDirectory } from "../ops/invite.js";
import type { TokenVerifier } from "./auth.js";
import type { EvidenceStore } from "../ops/evidenceStore.js";

export type Env = { Variables: { principal: Principal; requestId: string } };

/** Events stay visible for a while after they happened, so people can see what they missed. */
const PAST_EVENTS_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDeps {
  repo: Repository;
  verifier: TokenVerifier;
  now?: () => Date;
  /** Extra authenticated routes; used only by the local server for dev tools. */
  extend?: (app: Hono<Env>) => void;
  /** Kill switch: when it returns true, every route answers 503 (FM-13). */
  isPaused?: () => Promise<boolean>;
  /** Where logins live (Cognito in AWS); without it, inviting is unavailable. */
  logins?: LoginDirectory;
  /** Change history; without it, timelines are unavailable. */
  history?: HistoryStore;
  /** Live issuer-rights check. Bot tokens fail closed when no directory is configured. */
  botIssuerGroups?: BotIssuerGroups;
  /** Private immutable evidence objects (S3 in AWS). */
  evidence?: EvidenceStore;
}

export function createApp({ repo, verifier, now = () => new Date(), extend, isPaused, logins, history, botIssuerGroups = async () => undefined, evidence }: AppDeps) {
  const app = new Hono<Env>().basePath("/v1");

  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? ulid());
    await next();
    c.header("x-request-id", c.get("requestId"));
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json(
        { type: `about:blank#${err.code}`, title: err.message, status: err.status, detail: err.details },
        err.status as 400,
        { "content-type": "application/problem+json" },
      );
    }
    console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), message: String(err) }));
    return c.json({ type: "about:blank", title: "Internal error", status: 500 }, 500, {
      "content-type": "application/problem+json",
    });
  });

  app.notFound((c) =>
    c.json({ type: "about:blank#not_found", title: "Not found", status: 404 }, 404, {
      "content-type": "application/problem+json",
    }),
  );

  // Runs before auth and before any database call, so a paused API costs almost nothing.
  if (isPaused) {
    app.use("*", async (c, next) => {
      if (!(await isPaused())) return next();
      return c.json(
        { type: "about:blank#paused", title: "POP HQ is paused. Please try again later.", status: 503 },
        503,
        { "content-type": "application/problem+json", "retry-after": "3600" },
      );
    });
  }

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Bot-specific surface. Normal GET routes also accept bot tokens as their live issuer;
  // normal write routes do not. Dry-run is the default for the one scoped bot write.
  app.get("/agent/doctor", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    return c.json({ status: "ok", tokenId: token.tokenId, scopes: effectiveBotScopes(token), expiresAt: token.expiresAt });
  });

  /** Reads preserved import records that do not yet have a richer product-specific view. */
  app.get("/agent/history", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    const category = c.req.query("category");
    if (!category || !HISTORICAL_CATEGORIES.includes(category as HistoricalCategory)) {
      throw new ValidationError(`category must be one of: ${HISTORICAL_CATEGORIES.join(", ")}.`);
    }
    return c.json({ items: await repo.listHistoricalRecords(category as HistoricalCategory) });
  });

  app.get("/agent/history/evidence/:recordId/content", async (c) => {
    const { issuerGroups } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    requireAgentOfficer(issuerGroups);
    if (!evidence) throw new NotFoundError("Evidence storage is unavailable.");
    const recordId = historicalRecordId(c.req.param("recordId"));
    const object = await evidence.get(recordId);
    c.header("content-type", object.contentType);
    c.header("x-content-sha256", object.sha256);
    c.header("content-disposition", `inline; filename="${recordId}"`);
    return c.body(Buffer.from(object.content));
  });

  /** Uploads one hash-verified private evidence object; existing bytes are never overwritten. */
  app.put("/agent/history/evidence/:recordId/content", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    if (!evidence) throw new NotFoundError("Evidence storage is unavailable.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "evidence");
    }
    const recordId = historicalRecordId(c.req.param("recordId"));
    if (typeof body.contentBase64 !== "string" || body.contentBase64.length === 0) throw new ValidationError("contentBase64 is required.");
    const content = Buffer.from(body.contentBase64, "base64");
    if (content.byteLength === 0 || content.byteLength > 5 * 1024 * 1024) throw new ValidationError("Evidence content must be between 1 byte and 5 MB.");
    const canonicalBase64 = content.toString("base64").replace(/=+$/, "");
    if (canonicalBase64 !== body.contentBase64.replace(/\s+/g, "").replace(/=+$/, "")) throw new ValidationError("contentBase64 is not valid base64.");
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (typeof body.sha256 !== "string" || body.sha256.toLowerCase() !== sha256) throw new ValidationError("Evidence SHA-256 does not match its content.");
    const contentType = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    if (!/^(?:image\/(?:jpeg|png|webp)|application\/(?:pdf|json)|text\/plain)$/.test(contentType)) throw new ValidationError("Unsupported evidence content type.");
    const desired = { recordId, sha256, size: content.byteLength, contentType };
    const current = await evidence.head(recordId);
    if (current && canonicalJson(current) !== canonicalJson(desired)) throw new ConflictError(`Evidence content ${recordId} already exists with different bytes or metadata.`);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    if (!current) await evidence.put(desired, content);
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, desired);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), evidence: desired }, current ? 200 : 201);
  });

  /** Imports one immutable typed strength/power report with its original timestamps. */
  app.put("/agent/history/reports/:pid/:reportId", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason || !expectedHash) throw new ValidationError("Applying historical data requires a reason and the expectedHash from preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      const replay = await repo.getIdempotentChange(token.tokenId, key);
      if (replay) {
        if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, report: replay.response });
      }
    }
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const report = parseImportedReport(body, playerId, c.req.param("reportId"), now());
    const current = await repo.getReport(playerId, report.reportId);
    const currentHash = createHash("sha256").update(canonicalJson(current ?? null)).digest("hex");
    if (current && canonicalJson(current) !== canonicalJson(report)) throw new ConflictError(`Report ${report.reportId} already exists with different data.`);
    if (apply && expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(report)) throw new ConflictError("Report history changed after preview. Preview again before applying.");
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: report } });
    if (!current) await repo.addReport(report, { id: token.tokenId, via: `agent:${token.tokenId}`, reason });
    await repo.putIdempotentChange(token.tokenId, key, bodyHash, report);
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), report }, current ? 200 : 201);
  });

  /** Imports one historical signup/withdrawal without reopening the event. */
  app.put("/agent/history/events/:id/signups/:pid", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "signup");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const choice = parseAnswerChoice(event, body);
    const answeredAt = historicalTimestamp(body.answeredAt, "answeredAt");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : undefined;
    const desired = { eventId: event.eventId, playerId, ...choice, answeredAt, source: "import" as const, ...(note ? { note } : {}) };
    const current = await repo.getAnswer(event.eventId, playerId);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    const saved = canonicalJson(current) === canonicalJson(desired)
      ? desired
      : await repo.setAnswer(event, playerId, choice, "import", agentActor(token.tokenId, write.reason), note, { historic: true, answeredAt });
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, saved);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: canonicalJson(current) === canonicalJson(desired), signup: saved });
  });

  /** Imports one actual attendance observation, preserving its source time and evidence reference. */
  app.put("/agent/history/events/:id/attendance/:pid", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "attendance");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const playerId = parsePlayerId(c.req.param("pid"));
    const account = await repo.getAccount(playerId);
    if (!account || !["active", "guest", "unknown"].includes(account.status)) throw new NotFoundError(`Game account ${playerId} can't receive historical data.`);
    const parsed = parseAttendance(body);
    if (parsed.sessionId && !event.sessions.some((session) => session.id === parsed.sessionId)) throw new ValidationError("That part of the event doesn't exist.");
    const recordedAt = historicalTimestamp(body.recordedAt, "recordedAt");
    const source = ["officer", "screenshot", "agent", "import"].includes(String(body.source))
      ? body.source as "officer" | "screenshot" | "agent" | "import"
      : "import";
    const desired = { eventId: event.eventId, playerId, ...parsed, source, recordedAt };
    const current = await repo.getAttendance(event.eventId, playerId);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, desired);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: desired } });
    const saved = canonicalJson(current) === canonicalJson(desired)
      ? desired
      : await repo.setAttendance({ eventId: event.eventId, playerId, ...parsed, source }, agentActor(token.tokenId, write.reason), recordedAt);
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, saved);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, unchanged: canonicalJson(current) === canonicalJson(desired), attendance: saved });
  });

  /** Imports the reviewed starter/substitute decision for one historical event part. */
  app.put("/agent/history/events/:id/sessions/:sid/lineup", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "lineup");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const current = await repo.getLineup(event.eventId, session.id);
    const publishedAt = historicalTimestamp(body.publishedAt, "publishedAt");
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ValidationError("Historical lineups require expectedVersion.");
    const lineup = parseLineup(body, session, { eventId: event.eventId, sessionId: session.id, publishedBy: `agent:${token.tokenId}`, now: new Date(publishedAt), currentVersion: Number(body.expectedVersion) });
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = lineup.entries.filter((entry) => !known.has(entry.playerId)).map((entry) => entry.playerId);
    if (strangers.length > 0) throw new ValidationError(`Unknown Player IDs: ${strangers.join(", ")}.`);
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, lineup);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: lineup } });
    if (canonicalJson(current) !== canonicalJson(lineup)) await repo.putLineup(lineup, agentActor(token.tokenId, write.reason));
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, lineup);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, lineup }, 201);
  });

  /** Imports one reviewed tactical plan; assignments must still belong to the published lineup. */
  app.put("/agent/history/events/:id/sessions/:sid/strategy", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "history:write", now(), botIssuerGroups);
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const write = agentWriteRequest(body, c.req.query("apply") === "true", c.req.header("idempotency-key"));
    if (write.apply) {
      const replay = await repo.getIdempotentChange(token.tokenId, write.key);
      if (replay) return replayAgentChange(c, replay, write.bodyHash, "strategy");
    }
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const current = await repo.getStrategy(event.eventId, session.id);
    const publishedAt = historicalTimestamp(body.publishedAt, "publishedAt");
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ValidationError("Historical tactics require expectedVersion.");
    const strategy = parseStrategy(body, session, { eventId: event.eventId, sessionId: session.id, publishedBy: `agent:${token.tokenId}`, now: new Date(publishedAt), currentVersion: Number(body.expectedVersion) });
    if (strategy.assignments.length > 0) {
      const lineup = await repo.getLineup(event.eventId, session.id);
      if (!lineup) throw new ValidationError("Import the lineup before tactical assignments.");
      const selected = new Set(lineup.entries.map((entry) => entry.playerId));
      const outside = strategy.assignments.filter((assignment) => !selected.has(assignment.playerId)).map((assignment) => assignment.playerId);
      if (outside.length > 0) throw new ValidationError(`Not in the published ${session.label} lineup: ${outside.join(", ")}.`);
    }
    const currentHash = stateHash(current);
    assertPreviewState(write, currentHash, current, strategy);
    if (!write.apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: strategy } });
    if (canonicalJson(current) !== canonicalJson(strategy)) await repo.putStrategy(strategy, agentActor(token.tokenId, write.reason));
    await repo.putIdempotentChange(token.tokenId, write.key, write.bodyHash, strategy);
    c.header("x-change-id", write.key);
    return c.json({ dryRun: false, replayed: false, strategy }, 201);
  });

  /** Preserves one exact, immutable source fact. Preview is the default; ids make retries stable. */
  app.put("/agent/history/:recordId", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "history:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying a historical import requires a reason.");
      if (!expectedHash) throw new ValidationError("Applying a historical import requires the expectedHash from its preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      const replay = await repo.getIdempotentChange(token.tokenId, key);
      if (replay) {
        if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, record: replay.response });
      }
    }
    const record = parseHistoricalRecord(c.req.param("recordId"), body);
    const current = await repo.getHistoricalRecord(record.category, record.recordId);
    const currentHash = createHash("sha256").update(canonicalJson(current ?? null)).digest("hex");
    if (current && canonicalJson(current) !== canonicalJson(record)) {
      throw new ConflictError(`Historical record ${record.recordId} already exists with different data.`);
    }
    if (apply && expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(record)) throw new ConflictError("Historical data changed after preview. Preview again before applying.");
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current ?? null, after: record } });
    if (!current) await repo.createHistoricalRecord(record, { id: token.tokenId, via: `agent:${token.tokenId}`, reason });
    await repo.putIdempotentChange(token.tokenId, key, bodyHash, record);
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, unchanged: Boolean(current), record }, current ? 200 : 201);
  });

  /** Minimal event discovery for result bots; no sign-ups, notes, accounts or officer data. */
  app.get("/agent/events", async (c) => {
    await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    const requestedFrom = c.req.query("from");
    if (requestedFrom && Number.isNaN(Date.parse(requestedFrom))) throw new ValidationError("from must be an ISO date or timestamp.");
    const requestedKind = c.req.query("kind");
    if (requestedKind && !EVENT_KINDS.includes(requestedKind as EventKind)) throw new ValidationError("Unknown event kind.");
    const from = requestedFrom
      ? new Date(requestedFrom).toISOString()
      : new Date(now().getTime() - PAST_EVENTS_MS).toISOString();
    const events = await repo.listEvents("POP", from);
    return c.json({
      items: events
        .filter((event) => !requestedKind || event.kind === requestedKind)
        .map((event) => ({
          eventId: event.eventId,
          kind: event.kind,
          title: event.title,
          startsAt: event.startsAt,
          sessions: event.sessions.map((session) => ({ id: session.id, label: session.label, startsAt: session.startsAt })),
        })),
    });
  });

  /** Guarded event creation, including faithful historical events. Preview is always the default. */
  app.post("/agent/events", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "events:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying an agent event change requires a reason.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
        throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      }
      const previous = await repo.getIdempotentEvent(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, event: previous.event });
      }
    }
    const event = parseAgentNewEvent(body, {
      createdBy: `agent:${token.tokenId}`,
      now: now(),
    });
    if (await repo.getEvent(event.eventId)) throw new ConflictError(`Event ${event.eventId} already exists.`);
    if (!apply) return c.json({ dryRun: true, diff: { before: null, after: event } });
    await repo.putEventIdempotent(
      event,
      "create",
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason },
      token.tokenId,
      key,
      bodyHash,
    );
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, event }, 201);
  });

  /** Guarded event/session metadata editing. Existing session ids remain durable foreign keys. */
  app.patch("/agent/events/:id", async (c) => {
    const { token } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "events:write",
      now(),
      botIssuerGroups,
    );
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying an agent event change requires a reason.");
      if (!expectedHash) throw new ValidationError("Applying an event edit requires the expectedHash from its preview.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
        throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      }
      const previous = await repo.getIdempotentEvent(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, event: previous.event });
      }
    }
    const current = await repo.getEvent(c.req.param("id"));
    if (!current) throw new NotFoundError("Event not found.");
    const currentHash = createHash("sha256").update(canonicalJson(current)).digest("hex");
    if (apply && expectedHash !== currentHash) {
      throw new ConflictError("The event changed after preview. Preview the edit again before applying it.");
    }
    const updated = parseAgentEventChanges(current, body, now());
    if (!apply) return c.json({ dryRun: true, expectedHash: currentHash, diff: { before: current, after: updated } });
    await repo.putEventIdempotent(
      updated,
      "update",
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason },
      token.tokenId,
      key,
      bodyHash,
      current,
    );
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, event: updated });
  });

  app.get("/agent/events/:id/sessions/:sid/result-context", async (c) => {
    const { issuerGroups } = await authenticateAgent(
      repo,
      c.req.header("authorization"),
      c.req.header("origin"),
      "all:read",
      now(),
      botIssuerGroups,
    );
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const accountList = await repo.listAccounts(event.alliance);
    const accounts = new Map(accountList.map((account) => [account.playerId, account.name]));
    const lineup = await repo.getLineup(event.eventId, session.id);
    return c.json({
      event: { eventId: event.eventId, title: event.title, kind: event.kind },
      session,
      lineup: lineup?.entries.map((entry) => ({ ...entry, name: accounts.get(entry.playerId) ?? entry.playerId })) ?? [],
      // Officers can already read this registry through /roster. Returning the same exact ids and
      // names here lets result bots map a legacy scoreboard without pretending it had a lineup.
      ...([...issuerGroups].some((group) => group === "officer" || group === "owner")
        ? { players: accountList.map(({ playerId, name }) => ({ playerId, name })) }
        : {}),
      result: (await repo.getResult(event.eventId, session.id)) ?? null,
    });
  });

  app.put("/agent/events/:id/sessions/:sid/result", async (c) => {
    const { token } = await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "results:write", now(), botIssuerGroups);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    if (Date.parse(session.startsAt) > now().getTime()) throw new ValidationError("Record the result after this event part starts.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const apply = c.req.query("apply") === "true";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const key = c.req.header("idempotency-key") ?? "";
    const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    if (apply) {
      if (!reason) throw new ValidationError("Applying an agent result requires a reason.");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
      // Replay before version validation: the original request legitimately carries the old
      // expectedVersion after its first successful application.
      const previous = await repo.getIdempotentResult(token.tokenId, key);
      if (previous) {
        if (previous.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
        return c.json({ dryRun: false, replayed: true, result: previous.result });
      }
    }
    const current = await repo.getResult(event.eventId, session.id);
    const result = parseEventResult(body, session, {
      eventId: event.eventId,
      recordedBy: `agent:${token.tokenId}`,
      now: now(),
      currentVersion: current?.version ?? 0,
    });
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = result.playerPoints.filter((row) => !known.has(row.playerId)).map((row) => row.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    if (!apply) return c.json({ dryRun: true, diff: { before: current ?? null, after: result } });
    await repo.putResultIdempotent(
      result,
      { id: token.tokenId, via: `agent:${token.tokenId}`, reason },
      token.tokenId,
      key,
      bodyHash,
    );
    c.header("x-change-id", key);
    return c.json({ dryRun: false, replayed: false, result }, 201);
  });

  // Everything below requires a verified token.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) throw new UnauthorizedError();
    let principal: Principal;
    let linked: Set<string>;
    if (match[1].startsWith("s26_")) {
      if (c.req.method !== "GET") throw new ForbiddenError("Bot tokens cannot use normal write routes.");
      const authenticated = await authenticateAgent(repo, header, c.req.header("origin"), "all:read", now(), botIssuerGroups);
      linked = new Set(await repo.linkedAccounts(authenticated.token.issuedBy));
      principal = { sub: authenticated.token.issuedBy, groups: authenticated.issuerGroups, linkedAccounts: linked };
    } else {
      const token = await verifier(match[1]);
      linked = new Set(await repo.linkedAccounts(token.sub));
      principal = { sub: token.sub, groups: parseGroups(token.groups), linkedAccounts: linked };
    }
    const acting = resolveActingAccount(c.req.header("x-account-id"), linked);
    if (acting) principal.actingAs = acting;
    c.set("principal", principal);
    await next();
  });

  app.get("/me", async (c) => {
    const p = c.get("principal");
    const accounts = await Promise.all([...p.linkedAccounts].map((id) => repo.getAccount(id)));
    return c.json({
      sub: p.sub,
      groups: [...p.groups],
      actingAs: p.actingAs ?? null,
      accounts: accounts.filter((a) => a !== undefined),
    });
  });

  /** Officers issue narrow bot credentials; the secret is returned exactly once. */
  app.post("/agent-tokens", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const active = (await repo.listAgentTokens(p.sub)).filter((token) => !token.revokedAt && Date.parse(token.expiresAt) > now().getTime());
    if (active.length >= 5) throw new ConflictError("You already have five active bot tokens. Revoke one first.");
    const issued = issueAgentToken(await readJson(c.req.raw), p.sub, now());
    await repo.createAgentToken(issued.record);
    return c.json({ ...publicAgentToken(issued.record), token: issued.token }, 201);
  });

  app.get("/agent-tokens", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const records = await repo.listAgentTokens(p.groups.has("owner") ? undefined : p.sub);
    return c.json({ items: records.map(publicAgentToken) });
  });

  app.delete("/agent-tokens/:tokenId", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    await repo.revokeAgentToken(c.req.param("tokenId"), p.sub, now());
    return c.json({ revoked: true });
  });

  app.get("/accounts", async (c) => {
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    return c.json({ items: await repo.listAccounts(alliance) });
  });

  app.post("/accounts", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const account = parseNewAccount(await readJson(c.req.raw));
    await repo.createAccount(account, { id: p.sub, via: "web" });
    return c.json(account, 201);
  });

  app.get("/accounts/:pid", async (c) => {
    const account = await repo.getAccount(parsePlayerId(c.req.param("pid")));
    if (!account) throw new NotFoundError("Game account not found.");
    return c.json(account);
  });

  app.post("/accounts/:pid/links", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const body = (await readJson(c.req.raw)) as { sub?: unknown };
    if (typeof body.sub !== "string" || body.sub.length === 0) throw new ValidationError("sub is required.");
    await repo.linkAccount(body.sub, pid, { id: p.sub, via: "web", reason: "verified by officer" });
    return c.json({ sub: body.sub, playerId: pid }, 201);
  });

  app.get("/accounts/:pid/reports", async (c) => {
    const pid = parsePlayerId(c.req.param("pid"));
    const reports = await repo.listReports(pid);
    return c.json({ items: reports, current: currentValues(reports) });
  });

  /** Officer roster: every account with its latest and previous city power (ROS-01). */
  app.get("/roster", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    const accounts = await repo.listAccounts(alliance);
    // One query per account is fine at alliance size (~100); a summary item replaces this later.
    const items = await Promise.all(
      accounts.map(async (account) => {
        const reports = await repo.listReports(account.playerId);
        const superseded = new Set(reports.flatMap((r) => (r.supersedesReportId ? [r.supersedesReportId] : [])));
        const series = reports
          .filter((r) => !superseded.has(r.reportId))
          .flatMap((r) => {
            const v = r.values.find((x) => x.metric === "city_power")?.value;
            return typeof v === "number" ? [{ at: r.effectiveAt, power: v }] : [];
          })
          .toSorted((a, b) => a.at.localeCompare(b.at));
        const cur = currentValues(reports);
        const attendance = await repo.attendanceFor(account.playerId);
        const foundrySeries = seriesOf(reports, "foundry_strength");
        return {
          ...account,
          // Six trailing months for the small graphs in the table (MET-02).
          powerTrend: monthlyValues(
            series.map((p) => ({ at: p.at, value: p.power })),
            at,
          ),
          strengthTrend: monthlyValues(foundrySeries, at),
          // Trailing three-month average, so one bad night does not look like a collapse.
          attendanceTrend: trailingAverage(monthlyAttendance(attendance, at)),
          power: series.at(-1)?.power ?? null,
          previousPower: series.at(-2)?.power ?? null,
          foundryStrength: foundrySeries.at(-1)?.value ?? null,
          attendance: reliabilityOf(attendance),
          lastFoundryReportAt: foundrySeries.at(-1)?.at ?? null,
          lastReportAt: series.at(-1)?.at ?? null,
          furnace: cur.furnace_level?.value ?? null,
          reports: reports.length,
        };
      }),
    );
    return c.json({ items, seats: await repo.seats() });
  });

  /**
   * Invites someone: creates the login (emailed codes, no password), the game account and the
   * link between them (P4.1). Repeating the same invite changes nothing. Without an email it
   * only adds the game account, for members who report through an officer.
   */
  if (logins) {
    app.post("/invites", async (c) => {
      const p = c.get("principal");
      requireOfficer(p);
      const body = (await readJson(c.req.raw)) as Record<string, unknown>;
      const result = await invite(
        { repo, logins, actor: { id: p.sub, via: "web", reason: "invite" } },
        {
          ...(typeof body.email === "string" ? { email: body.email } : {}),
          playerId: String(body.playerId ?? ""),
          name: String(body.name ?? ""),
          ...(typeof body.rank === "string" ? { rank: body.rank } : {}),
          ...(typeof body.alliance === "string" ? { alliance: body.alliance } : {}),
        },
      );
      return c.json(result, result.accountCreated || result.linked || result.loginCreated ? 201 : 200);
    });
  }

  /**
   * What changed for a game account and when (DATA-02). Members see their own accounts;
   * officers see everyone (decision: who sees what, docs/PLAN.md).
   */
  if (history) {
    app.get("/accounts/:pid/timeline", async (c) => {
      const p = c.get("principal");
      const pid = parsePlayerId(c.req.param("pid"));
      if (!p.linkedAccounts.has(pid)) requireOfficer(p);
      if (!(await repo.getAccount(pid))) throw new NotFoundError(`Game account ${pid} not found.`);
      const limit = Number(c.req.query("limit") ?? 50);
      const before = c.req.query("before");
      const page = await history.timeline(`ACCOUNT#${pid}`, Number.isFinite(limit) ? limit : 50, before);
      return c.json(page);
    });
  }

  /**
   * Alliance growth for the officer charts (MET-01): totals over time, who grew, who stalled
   * and who never reported. Officer-only, like the roster.
   */
  app.get("/metrics/alliance", async (c) => {
    requireOfficer(c.get("principal"));
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const metric = c.req.query("metric") === "foundry_strength" ? "foundry_strength" : "city_power";
    const weeks = Math.min(Math.max(Number(c.req.query("weeks") ?? 12) || 12, 2), 52);
    // Cohort: confirmed members and guests by default. Accounts whose membership is unknown
    // (imported history) would inflate the totals, so they are counted separately and only
    // included on request.
    const cohort = c.req.query("cohort") === "all" ? "all" : "members";
    const all = await repo.listAccounts(alliance);
    const counted = all.filter((a) => a.status === "active" || a.status === "guest");
    const unknown = all.filter((a) => a.status === "unknown");
    const accounts = cohort === "all" ? [...counted, ...unknown] : counted;
    const series = await Promise.all(
      accounts.map(async (account) => ({
        playerId: account.playerId,
        name: account.name,
        points: seriesOf(await repo.listReports(account.playerId), metric),
      })),
    );
    return c.json({
      ...allianceGrowth(metric, series, buckets(now(), weeks)),
      weeks,
      alliance,
      cohort,
      unknownMembership: unknown.length,
    });
  });

  // ---- Event types (EVT-01) ----

  /** The types events can be created from. Everyone may read them; officers may change them. */
  app.get("/event-types", async (c) => {
    const p = c.get("principal");
    const types = await listEventTypes(repo, { id: p.sub, via: "web" });
    return c.json({ items: types.filter((t) => !t.archived), archived: types.filter((t) => t.archived) });
  });

  app.post("/event-types", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const type = parseEventType(await readJson(c.req.raw), p.sub);
    if (await repo.getEventType(type.typeId)) throw new ConflictError(`An event type "${type.typeId}" already exists.`);
    await repo.putEventType(type, { id: p.sub, via: "web", reason: "new event type" });
    return c.json(type, 201);
  });

  app.patch("/event-types/:typeId", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const existing = await repo.getEventType(c.req.param("typeId"));
    if (!existing) throw new NotFoundError("Event type not found.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const updated = parseEventType({ ...existing, ...body, typeId: existing.typeId }, existing.createdBy);
    await repo.putEventType(updated, { id: p.sub, via: "web", reason: "event type changed" });
    return c.json(updated);
  });

  // ---- Events (EVT-01..EVT-04) ----

  /** Officers schedule an event; answers close at the deadline. */
  app.post("/events", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = parseNewEvent(await readJson(c.req.raw), {
      eventId: ulid(),
      createdBy: p.sub,
      now: now(),
    });
    await repo.createEvent(event, { id: p.sub, via: "web" });
    return c.json(event, 201);
  });

  /**
   * Officers record who actually turned up (EVT-07). One record per game account per event;
   * recording it again replaces the earlier record and keeps the old one in the history.
   */
  app.put("/events/:id/attendance/:pid", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const input = parseAttendance(await readJson(c.req.raw));
    if (input.sessionId && !event.sessions.some((s) => s.id === input.sessionId)) {
      throw new ValidationError("That part of the event doesn't exist.");
    }
    const saved = await repo.setAttendance(
      { ...input, eventId: event.eventId, playerId: pid, source: "officer" },
      { id: p.sub, via: "web", reason: "attendance" },
    );
    return c.json(saved);
  });

  /** A member's reliability: how often they kept a commitment. Own account, or any for officers. */
  app.get("/accounts/:pid/reliability", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    if (!p.linkedAccounts.has(pid)) requireOfficer(p);
    return c.json(reliabilityOf(await repo.attendanceFor(pid)));
  });

  // ---- SvS buff slots (BUF-01..BUF-06) ----

  /** Officers open a round: three buff days and the moment preferences close. */
  app.post("/svs-rounds", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const round = parseNewRound(await readJson(c.req.raw), { roundId: ulid(), createdBy: p.sub, now: now() });
    await repo.putRound(round, { id: p.sub, via: "web" });
    return c.json({ ...round, state: roundState(round, now()) }, 201);
  });

  /** Rounds that have not finished, earliest first, with whether you have answered. */
  app.get("/svs-rounds", async (c) => {
    const p = c.get("principal");
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    // A round stays listed until its last buff day is over.
    const from = new Date(at.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rounds = await repo.listRounds(alliance, from);
    const acting = defaultActing(p);
    const items = await Promise.all(
      rounds.map(async (round) => ({
        ...round,
        state: roundState(round, at),
        answered: acting ? (await repo.getPreferences(round.roundId, acting)) !== undefined : false,
      })),
    );
    return c.json({ items });
  });

  /**
   * One round: its days and slots, your own preferences, and how many people want each slot.
   * Demand is visible to everyone — it helps members pick a quiet hour, which is the point.
   */
  app.get("/svs-rounds/:id", async (c) => {
    const p = c.get("principal");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Round not found.");
    const at = now();
    const preferences = await repo.listPreferences(round.roundId);
    const acting = defaultActing(p);

    const days = round.days.map((day) => {
      const answers = preferences.flatMap((pref) => pref.days.filter((d) => d.dayId === day.id));
      const demand = Array.from({ length: SLOTS_PER_DAY }, (_, slot) => answers.filter((a) => a.slots.includes(slot)).length);
      return {
        ...day,
        startsAt: slotStartsAt(day, 0),
        endsAt: dayEndsAt(day),
        demand,
        anyTime: answers.filter((a) => a.anyTime).length,
        unavailable: answers.filter((a) => a.unavailable).length,
      };
    });

    return c.json({
      ...round,
      state: roundState(round, at),
      days,
      answeredBy: preferences.length,
      yourPreferences: acting ? ((await repo.getPreferences(round.roundId, acting))?.days ?? null) : null,
    });
  });

  /** Your times for a round. Members answer for their own accounts, until the deadline. */
  app.put("/svs-rounds/:id/preferences/:pid", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    // Preferences are the member's own word about when they can play, so officers do not
    // overwrite them; after the deadline officers assign slots instead.
    if (!p.linkedAccounts.has(pid)) throw new ForbiddenError("You can only set your own times.");
    const round = await repo.getRound(c.req.param("id"));
    if (!round) throw new NotFoundError("Round not found.");
    const preferences = parsePreferences(round, await readJson(c.req.raw), { playerId: pid, now: now() });
    const saved = await repo.setPreferences(preferences, { id: p.sub, via: "web" });
    return c.json(saved);
  });

  /** Kudos an officer awarded to a game account, with the decayed score they add up to. */
  app.get("/accounts/:pid/kudos", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    if (!p.linkedAccounts.has(pid)) requireOfficer(p);
    const awards = await repo.listKudos(pid);
    return c.json({ items: awards, score: kudosScore(awards, now()) });
  });

  /** Officers award kudos for what the numbers cannot see. Awards are immutable. */
  app.post("/accounts/:pid/kudos", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const pid = parsePlayerId(c.req.param("pid"));
    const award = parseKudos(await readJson(c.req.raw), {
      awardId: ulid(),
      playerId: pid,
      awardedBy: p.sub,
      now: now(),
    });
    await repo.addKudos(award, { id: p.sub, via: "web", reason: "kudos awarded" });
    return c.json(award, 201);
  });

  /** Officers change an event: title, type, start, deadline or notes. Answers stay. */
  app.patch("/events/:id", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const updated = parseEventChanges(event, await readJson(c.req.raw), now());
    await repo.updateEvent(updated, { id: p.sub, via: "web", reason: "event edited" });
    return c.json(updated);
  });

  /**
   * Repairs a legacy event that predates selectable parts. Existing yes answers are assigned to
   * the new part in the same transaction so result tooling never observes a half-migrated event.
   */
  app.post("/events/:id/session", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    if (event.sessions.length > 0) throw new ConflictError("This event already has a configured part.");
    const updated = configureLegacySession(event, await readJson(c.req.raw), now());
    const assignedSignups = await repo.configureLegacySession(
      updated,
      await repo.listAnswers(event.eventId),
      { id: p.sub, via: "web", reason: "legacy event part configured" },
    );
    return c.json({ event: updated, assignedSignups }, 201);
  });

  /** Upcoming events with the answer of the account the person is acting for. */
  app.get("/events", async (c) => {
    const p = c.get("principal");
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    const requestedFrom = c.req.query("from");
    if (requestedFrom && Number.isNaN(Date.parse(requestedFrom))) throw new ValidationError("from must be an ISO date or timestamp.");
    const from = requestedFrom
      ? new Date(requestedFrom).toISOString()
      : new Date(at.getTime() - PAST_EVENTS_MS).toISOString();
    const events = await repo.listEvents(alliance, from);
    const acting = defaultActing(p);
    const mine = acting ? await repo.answersForAccount(acting, from) : [];
    const byEvent = new Map(mine.map((a) => [a.eventId, a]));
    const items = events.map((event) => ({
      ...event,
      closed: isClosed(event, at),
      myAnswer: byEvent.get(event.eventId)?.answer ?? null,
      mySessionId: byEvent.get(event.eventId)?.sessionId ?? null,
    }));
    return c.json({ items });
  });

  /** One event with its counts; officers also see who answered what and who is missing. */
  app.get("/events/:id", async (c) => {
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const answers = await repo.listAnswers(event.eventId);
    const accounts = await repo.listAccounts(event.alliance);
    // Anyone who can receive data can attend: members, guests, and accounts whose membership
    // is not confirmed yet (imported). Otherwise the table would show fewer people than answered.
    const expected = accounts.filter((a) => a.status === "active" || a.status === "guest" || a.status === "unknown");
    const counts = countAnswers(answers, expected.length);
    const acting = defaultActing(p);

    // Foundry strength and reliability of everyone who signed up, for the estimate.
    const yesAnswers = answers.filter((a) => a.answer === "yes");
    const lineups = new Map((await repo.listLineups(event.eventId)).map((l) => [l.sessionId, l]));
    const strategies = new Map((await repo.listStrategies(event.eventId)).map((strategy) => [strategy.sessionId, strategy]));
    const results = new Map((await repo.listResults(event.eventId)).map((result) => [result.sessionId, result]));
    // People in a published lineup need their strength shown too, even if an officer put someone
    // there who never answered.
    const needStrength = [
      ...new Set([...yesAnswers.map((a) => a.playerId), ...[...lineups.values()].flatMap((l) => l.entries.map((e) => e.playerId))]),
    ];
    const strengthOf = new Map<string, number | undefined>(
      await Promise.all(
        needStrength.map(async (pid) => [pid, currentOf(await repo.listReports(pid), "foundry_strength")] as const),
      ),
    );
    const reliabilityOfPlayer = new Map(
      await Promise.all(
        yesAnswers.map(async (a) => [a.playerId, reliabilityOf(await repo.attendanceFor(a.playerId))] as const),
      ),
    );
    const byName = new Map(accounts.map((a) => [a.playerId, a.name]));
    const sessions = event.sessions.map((session) => {
      const entries = yesAnswers
        .filter((a) => a.sessionId === session.id)
        .map((a) => ({
          playerId: a.playerId,
          strength: strengthOf.get(a.playerId),
          attendanceRate: reliabilityOfPlayer.get(a.playerId)?.rate,
          answeredAt: a.answeredAt,
        }));
      const standing = acting ? standingFor(session.id, entries, acting, session.starters) : undefined;
      // Everyone sees who signed up with their Foundry strength and likely role (that is what
      // decides the lineup). Reliability is officer business, as are power, furnace and notes.
      const ranked = rankSignUps(entries, session.starters).map((entry) => ({
        playerId: entry.playerId,
        name: byName.get(entry.playerId) ?? entry.playerId,
        foundryStrength: entry.strength ?? null,
        ...(isOfficer(p) ? { attendanceRate: entry.attendanceRate ?? null } : {}),
        position: entry.position,
        likely: entry.likely,
      }));
      // Once officers publish, the lineup replaces the estimate as the answer to "am I playing?".
      const published = lineups.get(session.id);
      const lineup = published
        ? {
            version: published.version,
            publishedAt: published.publishedAt,
            ...(published.note ? { note: published.note } : {}),
            entries: published.entries.map((entry) => ({
              playerId: entry.playerId,
              name: byName.get(entry.playerId) ?? entry.playerId,
              role: entry.role,
              position: entry.position,
              foundryStrength: strengthOf.get(entry.playerId) ?? null,
              /** An officer may pick someone who never answered; the UI says so. */
              signedUp: entries.some((e) => e.playerId === entry.playerId),
            })),
          }
        : null;
      const myPlace = acting ? placeIn(published, acting) : undefined;
      const publishedStrategy = strategies.get(session.id);
      const strategy = publishedStrategy
        ? {
            version: publishedStrategy.version,
            body: publishedStrategy.body,
            publishedAt: publishedStrategy.publishedAt,
            assignments: publishedStrategy.assignments.map((assignment) => ({
              ...assignment,
              name: byName.get(assignment.playerId) ?? assignment.playerId,
            })),
          }
        : null;
      const yourAssignment = acting
        ? strategy?.assignments.find((assignment) => assignment.playerId === acting)
        : undefined;
      const recordedResult = results.get(session.id);
      const result = recordedResult
        ? {
            version: recordedResult.version,
            outcome: recordedResult.outcome,
            ourScore: recordedResult.ourScore,
            opponentScore: recordedResult.opponentScore,
            ...(recordedResult.ourMatchmakingPower !== undefined ? { ourMatchmakingPower: recordedResult.ourMatchmakingPower } : {}),
            ...(recordedResult.opponentMatchmakingPower !== undefined
              ? { opponentMatchmakingPower: recordedResult.opponentMatchmakingPower }
              : {}),
            ...(recordedResult.opponentCombatants !== undefined ? { opponentCombatants: recordedResult.opponentCombatants } : {}),
            ...(recordedResult.notes ? { notes: recordedResult.notes } : {}),
            recordedAt: recordedResult.recordedAt,
            playerPoints: recordedResult.playerPoints
              .filter((row) => isOfficer(p) || row.playerId === acting)
              .map((row) => ({ ...row, name: byName.get(row.playerId) ?? row.playerId })),
          }
        : null;
      return {
        ...session,
        signedUp: entries.length,
        spotsLeft:
          session.starters === undefined ? null : Math.max(0, session.starters + (session.subs ?? 0) - entries.length),
        signedUpList: ranked,
        lineup,
        strategy,
        result,
        ...(myPlace ? { yourPlace: { role: myPlace.role, position: myPlace.position } } : {}),
        ...(yourAssignment
          ? {
              yourAssignment: {
                role: yourAssignment.role,
                ...(yourAssignment.duty ? { duty: yourAssignment.duty } : {}),
                ...(yourAssignment.note ? { note: yourAssignment.note } : {}),
              },
            }
          : {}),
        ...(standing ? { yourStanding: standing } : {}),
      };
    });

    const eventType = (await repo.getEventType(event.kind)) ?? STARTER_TYPES.find((type) => type.typeId === event.kind);

    const body: Record<string, unknown> = {
      ...event,
      sessions,
      closed: isClosed(event, now()),
      counts,
      myAnswer: (() => {
        const acting = defaultActing(p);
        return acting ? (answers.find((a) => a.playerId === acting)?.answer ?? null) : null;
      })(),
      mySessionId: (() => {
        const acting = defaultActing(p);
        return acting ? (answers.find((a) => a.playerId === acting)?.sessionId ?? null) : null;
      })(),
      ...(eventType?.strategyTemplate ? { strategyTemplate: eventType.strategyTemplate } : {}),
    };
    if (isOfficer(p)) {
      const byPlayer = new Map(answers.map((a) => [a.playerId, a]));
      const attendance = new Map((await repo.listAttendance(event.eventId)).map((a) => [a.playerId, a]));
      const history = new Map(
        await Promise.all(expected.map(async (a) => [a.playerId, await repo.attendanceFor(a.playerId)] as const)),
      );
      // Officers see the numbers they need to balance the legions (P8/EVT-04).
      const reports = new Map(
        await Promise.all(expected.map(async (a) => [a.playerId, await repo.listReports(a.playerId)] as const)),
      );
      // Where each person ended up in a published lineup, so the officer table shows the decision
      // next to the numbers it was based on.
      const placeOf = new Map<string, { sessionId: string; role: string; position: number }>();
      for (const l of lineups.values()) {
        for (const e of l.entries) placeOf.set(e.playerId, { sessionId: l.sessionId, role: e.role, position: e.position });
      }
      body.members = expected.map((account) => {
        const own = reports.get(account.playerId) ?? [];
        const current = currentValues(own);
        return {
          playerId: account.playerId,
          name: account.name,
          rank: account.rank ?? null,
          answer: byPlayer.get(account.playerId)?.answer ?? null,
          sessionId: byPlayer.get(account.playerId)?.sessionId ?? null,
          answeredAt: byPlayer.get(account.playerId)?.answeredAt ?? null,
          attended: attendance.get(account.playerId)?.status ?? null,
          lineup: placeOf.get(account.playerId) ?? null,
          strengthTrend: monthlyValues(seriesOf(own, "foundry_strength"), now()),
          attendanceTrend: trailingAverage(monthlyAttendance(history.get(account.playerId) ?? [], now())),
          power: currentOf(own, "city_power") ?? null,
          foundryStrength: currentOf(own, "foundry_strength") ?? null,
          furnace: current.furnace_level?.value ?? null,
          lastReportAt: own.length > 0 ? (current.city_power?.effectiveAt ?? null) : null,
        };
      });
    }
    return c.json(body);
  });

  /**
   * Publishes the lineup for one part of an event (P5.4). Officers only: this is the decision
   * that turns the strength estimate into "you are starting". Sending the version they edited
   * makes a stale publish fail instead of overwriting a colleague's work.
   */
  app.post("/events/:id/sessions/:sid/lineup", async (c) => {
    requireOfficer(c.get("principal"));
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((s) => s.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");

    const current = await repo.getLineup(event.eventId, session.id);
    const lineup = parseLineup(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      sessionId: session.id,
      publishedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    });
    // Everyone in a lineup must be an account we know; an unknown Player ID is a typo, not a plan.
    const known = new Set((await repo.listAccounts(event.alliance)).map((a) => a.playerId));
    const strangers = lineup.entries.filter((e) => !known.has(e.playerId)).map((e) => e.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    await repo.putLineup(lineup, { id: p.sub, via: "web", reason: "lineup published" });
    return c.json(lineup, 201);
  });

  /** Publishes the plan and assignments for one event part (P5.5). */
  app.post("/events/:id/sessions/:sid/strategy", async (c) => {
    requireOfficer(c.get("principal"));
    const p = c.get("principal");
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");

    const current = await repo.getStrategy(event.eventId, session.id);
    const strategy = parseStrategy(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      sessionId: session.id,
      publishedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    });

    // Assignments describe the published lineup; a strategy may still contain body-only guidance
    // before a lineup exists, but it cannot quietly assign someone who was not selected.
    if (strategy.assignments.length > 0) {
      const lineup = await repo.getLineup(event.eventId, session.id);
      if (!lineup) throw new ValidationError("Publish the lineup before assigning strategy roles.");
      const selected = new Set(lineup.entries.map((entry) => entry.playerId));
      const outside = strategy.assignments.filter((assignment) => !selected.has(assignment.playerId)).map((assignment) => assignment.playerId);
      if (outside.length > 0) throw new ValidationError(`Not in the published ${session.label} lineup: ${outside.join(", ")}.`);
    }

    await repo.putStrategy(strategy, { id: p.sub, via: "web", reason: "strategy published" });
    return c.json(strategy, 201);
  });

  /** Records or corrects the outcome of one event part (P5.6b). */
  app.post("/events/:id/sessions/:sid/result", async (c) => {
    const p = c.get("principal");
    requireOfficer(p);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    if (Date.parse(session.startsAt) > now().getTime()) throw new ValidationError("Record the result after this event part starts.");

    const current = await repo.getResult(event.eventId, session.id);
    const result = parseEventResult(await readJson(c.req.raw), session, {
      eventId: event.eventId,
      recordedBy: p.sub,
      now: now(),
      currentVersion: current?.version ?? 0,
    });
    const known = new Set((await repo.listAccounts(event.alliance)).map((account) => account.playerId));
    const strangers = result.playerPoints.filter((row) => !known.has(row.playerId)).map((row) => row.playerId);
    if (strangers.length > 0) throw new ValidationError(`Not members of ${event.alliance}: ${strangers.join(", ")}.`);

    await repo.putResult(result, { id: p.sub, via: "web", reason: "event result recorded" });
    return c.json(result, 201);
  });

  /** Answers for a game account: the player for their own accounts, officers for anyone. */
  app.put("/events/:id/answers/:pid", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, pid);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const body = (await readJson(c.req.raw)) as Record<string, unknown>;
    const choice = parseAnswerChoice(event, body);
    const saved = await repo.setAnswer(
      event,
      pid,
      choice,
      role,
      { id: p.sub, via: "web", ...(role === "officer" ? { reason: "officer edit" } : {}) },
      typeof body.note === "string" ? body.note.trim().slice(0, 200) : undefined,
      // Officers keep adjusting the list after answers close, up to the start of the event.
      { afterDeadline: role === "officer" },
    );
    return c.json(saved);
  });

  app.post("/accounts/:pid/reports", async (c) => {
    const p = c.get("principal");
    const pid = parsePlayerId(c.req.param("pid"));
    const role = requireCanWriteFor(p, pid);
    const report = parseReport(await readJson(c.req.raw), {
      playerId: pid,
      reportId: ulid(),
      source: role,
      now: now(),
    });
    await repo.addReport(report, { id: p.sub, via: "web" });
    return c.json(report, 201);
  });

  extend?.(app);
  return app;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be JSON.");
  }
}

interface AgentWriteRequest {
  apply: boolean;
  reason: string;
  expectedHash: string;
  key: string;
  bodyHash: string;
}

function agentWriteRequest(body: Record<string, unknown>, apply: boolean, key = ""): AgentWriteRequest {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
  if (apply) {
    if (!reason || !expectedHash) throw new ValidationError("Applying historical data requires a reason and the expectedHash from preview.");
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new ValidationError("Applying requires an Idempotency-Key of 8–100 safe characters.");
  }
  return {
    apply,
    reason,
    expectedHash,
    key,
    bodyHash: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  };
}

function stateHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex");
}

function assertPreviewState(write: AgentWriteRequest, currentHash: string, current?: unknown, desired?: unknown): void {
  if (write.apply && write.expectedHash !== currentHash && canonicalJson(current) !== canonicalJson(desired)) {
    throw new ConflictError("Historical data changed after preview. Preview again before applying.");
  }
}

function historicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${field} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function historicalRecordId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value)) throw new ValidationError("Invalid historical record id.");
  return value;
}

function agentActor(tokenId: string, reason: string): Actor {
  return { id: tokenId, via: `agent:${tokenId}`, reason };
}

function requireAgentOfficer(groups: ReadonlySet<string>): void {
  if (!groups.has("officer") && !groups.has("owner")) throw new ForbiddenError("The token issuer is no longer allowed to read officer history.");
}

function replayAgentChange(
  c: Context<Env>,
  replay: { bodyHash: string; response: unknown },
  bodyHash: string,
  field: string,
): Response {
  if (replay.bodyHash !== bodyHash) throw new ConflictError("That Idempotency-Key was already used for different data.");
  return c.json({ dryRun: false, replayed: true, [field]: replay.response });
}
