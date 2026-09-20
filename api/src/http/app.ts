import { Hono } from "hono";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { parseNewAccount } from "../domain/accounts.js";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../domain/errors.js";
import { parseAttendance, reliabilityOf } from "../domain/attendance.js";
import {
  EVENT_KINDS,
  countAnswers,
  isClosed,
  parseAnswerChoice,
  parseEventChanges,
  parseNewEvent,
  rankSignUps,
  standingFor,
  type EventKind,
} from "../domain/events.js";
import { parseEventType, STARTER_TYPES } from "../domain/eventTypes.js";
import { parseLineup, placeIn } from "../domain/lineups.js";
import { parseStrategy } from "../domain/strategy.js";
import { parseEventResult } from "../domain/results.js";
import { canonicalJson, issueAgentToken } from "../domain/agentTokens.js";
import { authenticateAgent, effectiveBotScopes, publicAgentToken, type BotIssuerGroups } from "./agentAuth.js";
import { listEventTypes } from "../ops/eventTypes.js";
import { parsePlayerId } from "../domain/identity.js";
import { allianceGrowth, buckets, currentOf, seriesOf } from "../domain/metrics.js";
import { monthlyAttendance, monthlyValues, trailingAverage } from "../domain/trends.js";
import { currentValues, parseReport } from "../domain/measurements.js";
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
import { invite, type LoginDirectory } from "../ops/invite.js";
import type { TokenVerifier } from "./auth.js";

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
}

export function createApp({ repo, verifier, now = () => new Date(), extend, isPaused, logins, history, botIssuerGroups = async () => undefined }: AppDeps) {
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

  app.get("/agent/events/:id/sessions/:sid/result-context", async (c) => {
    await authenticateAgent(repo, c.req.header("authorization"), c.req.header("origin"), "all:read", now(), botIssuerGroups);
    const event = await repo.getEvent(c.req.param("id"));
    if (!event) throw new NotFoundError("Event not found.");
    const session = event.sessions.find((candidate) => candidate.id === c.req.param("sid"));
    if (!session) throw new NotFoundError("That part of the event doesn't exist.");
    const accounts = new Map((await repo.listAccounts(event.alliance)).map((account) => [account.playerId, account.name]));
    const lineup = await repo.getLineup(event.eventId, session.id);
    return c.json({
      event: { eventId: event.eventId, title: event.title, kind: event.kind },
      session,
      lineup: lineup?.entries.map((entry) => ({ ...entry, name: accounts.get(entry.playerId) ?? entry.playerId })) ?? [],
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
        return {
          ...account,
          // Six trailing months for the small graphs in the table (MET-02).
          powerTrend: monthlyValues(
            series.map((p) => ({ at: p.at, value: p.power })),
            at,
          ),
          strengthTrend: monthlyValues(seriesOf(reports, "foundry_strength"), at),
          // Trailing three-month average, so one bad night does not look like a collapse.
          attendanceTrend: trailingAverage(monthlyAttendance(attendance, at)),
          power: series.at(-1)?.power ?? null,
          previousPower: series.at(-2)?.power ?? null,
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

  /** Upcoming events with the answer of the account the person is acting for. */
  app.get("/events", async (c) => {
    const p = c.get("principal");
    const alliance = (c.req.query("alliance") ?? "POP").toUpperCase();
    const at = now();
    const from = new Date(at.getTime() - PAST_EVENTS_MS).toISOString();
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
