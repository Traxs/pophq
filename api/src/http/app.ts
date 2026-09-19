import { Hono } from "hono";
import { ulid } from "ulid";
import { parseNewAccount } from "../domain/accounts.js";
import { DomainError, NotFoundError, UnauthorizedError, ValidationError } from "../domain/errors.js";
import { parsePlayerId } from "../domain/identity.js";
import { currentValues, parseReport } from "../domain/measurements.js";
import {
  parseGroups,
  requireCanWriteFor,
  requireOfficer,
  resolveActingAccount,
  type Principal,
} from "../domain/principal.js";
import type { Repository } from "../data/repository.js";
import { invite, type LoginDirectory } from "../ops/invite.js";
import type { TokenVerifier } from "./auth.js";

export type Env = { Variables: { principal: Principal; requestId: string } };

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
}

export function createApp({ repo, verifier, now = () => new Date(), extend, isPaused, logins }: AppDeps) {
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

  // Everything below requires a verified token.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) throw new UnauthorizedError();
    const token = await verifier(match[1]);
    const linked = new Set(await repo.linkedAccounts(token.sub));
    const principal: Principal = { sub: token.sub, groups: parseGroups(token.groups), linkedAccounts: linked };
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
        return {
          ...account,
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
