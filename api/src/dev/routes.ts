// Dev-only routes for loading demo data from the web app's Dev tab.
// Mounted only by the local server (src/server.ts); the Lambda entry point never imports this file.
import type { Hono } from "hono";
import { ValidationError } from "../domain/errors.js";
import { parsePlayerId } from "../domain/identity.js";
import type { Principal } from "../domain/principal.js";
import type { Repository } from "../data/repository.js";
import { addRandomMembers, backfillHistory, everyoneReports } from "./demo.js";

type Env = { Variables: { principal: Principal; requestId: string } };

export interface DevDeps {
  repo: Repository;
  /** Wipes the table and reloads the standard demo set. */
  reset: () => Promise<void>;
}

const int = (v: unknown, min: number, max: number, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${name} must be ${min}–${max}.`);
  return n;
};

export function registerDevRoutes(app: Hono<Env>, { repo, reset }: DevDeps): void {
  const actor = (p: Principal) => ({ id: p.sub, via: "seed" as const, reason: "dev tools" });

  app.post("/dev/members", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { count?: unknown };
    const created = await addRandomMembers(repo, int(body.count ?? 10, 1, 50, "count"), new Date(), actor(c.get("principal")));
    return c.json({ created: created.length, names: created.map((a) => a.name) });
  });

  app.post("/dev/history", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { playerId?: unknown; months?: unknown };
    const pid = parsePlayerId(body.playerId);
    const months = await backfillHistory(repo, pid, int(body.months ?? 12, 1, 36, "months"), new Date(), actor(c.get("principal")));
    return c.json({ playerId: pid, months });
  });

  app.post("/dev/report-round", async (c) => {
    return c.json(await everyoneReports(repo, new Date(), actor(c.get("principal"))));
  });

  app.post("/dev/reset", async (c) => {
    await reset();
    return c.json({ reset: true });
  });
}
