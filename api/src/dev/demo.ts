// Fake demo data for local development only. Never imported by the Lambda entry point.
import { ulid } from "ulid";
import { parseNewAccount, type GameAccount } from "../domain/accounts.js";
import { ConflictError } from "../domain/errors.js";
import { parseReport } from "../domain/measurements.js";
import type { Actor } from "../data/meta.js";
import type { Repository } from "../data/repository.js";
import { ANSWERS, parseNewEvent, type AllianceEvent } from "../domain/events.js";
import { parseLineup } from "../domain/lineups.js";
import { parseStrategy } from "../domain/strategy.js";
import { parseEventResult } from "../domain/results.js";

const DAY = 86_400_000;

/** Seeded PRNG (mulberry32) so demo data is reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Poppy", "Goatzilla", "IceQueen", "FrostByte", "Snowdrift", "Kilwa", "Blizzard", "Aurora",
  "Glacier", "Polaris", "Tundra", "Permafrost", "Hailstorm", "Icicle", "Coldfront", "Whiteout",
  "Avalanche", "Sleet", "Northwind", "Crystal", "Boreal", "Frostfire", "Snowcap", "Rime",
  "Floe", "Chill", "Yeti", "Winterfell", "Snowfox", "Iceberg", "Driftwood", "Emberfrost",
  "Stormcrow", "Wolfpack", "Nightfrost", "Silverpine", "Ironclad", "Coldsteel",
];
const EXTRA_PARTS = ["Frost", "Snow", "Ice", "Storm", "Polar", "Winter", "Hail", "Glacier", "North", "Rime"];
const EXTRA_ENDS = ["wolf", "fang", "heart", "blade", "born", "rider", "guard", "wing", "claw", "shard"];
const TROOP_TYPES = ["infantry", "lancer", "marksman"] as const;

/** Dev personas: login sub -> linked game accounts. The mock issuer maps client ids to these subs. */
export const PERSONA_LINKS: Record<string, string[]> = {
  player: ["100000001", "100000002"], // Poppy + her alt Goatzilla
  officer: ["100000008"], // Aurora, R4
  owner: ["100000010"], // Polaris, R5
};

const RANKS = ["R1", "R2", "R3", "R3", "R3", "R3", "R3", "R4"] as const;

function values(power: number, rand: () => number, furnace: number) {
  return [
    { metric: "city_power", value: power },
    // Foundry strength is its own metric and roughly a sixth of city power in POP's real data;
    // without it locally, every Foundry ranking and lineup shows a column of dashes.
    { metric: "foundry_strength", value: Math.round((power / 6000) * (0.85 + rand() * 0.3)) },
    { metric: "hero_power_total", value: Math.round(power * (0.25 + rand() * 0.1)) },
    { metric: "furnace_level", value: `FC${Math.min(10, furnace)}` },
    // Troops sit at or below the furnace level, and Helios is an extension some have on some
    // types — not a choice between them.
    ...TROOP_TYPES.flatMap((type) => {
      const level = Math.max(1, furnace - Math.floor(rand() * 2));
      return [
        { metric: `troop_level_${type}`, value: `FC${Math.min(10, level)}` },
        ...(rand() < 0.45 ? [{ metric: `helios_${type}`, value: "yes" }] : []),
      ];
    }),
  ];
}

async function addImported(
  repo: Repository,
  actor: Actor,
  playerId: string,
  at: Date,
  vals: ReturnType<typeof values>,
  now: Date,
) {
  const report = parseReport(
    { effectiveAt: at.toISOString(), values: vals },
    { playerId, reportId: ulid(at.getTime()), source: "import", now },
  );
  await repo.addReport(report, actor);
}

/** Runs tasks with bounded parallelism. */
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * Monthly history for one account going back `months` from `until`, growing towards `endPower`.
 * Some months are skipped at random, like real players who forget to report.
 */
async function writeHistory(
  repo: Repository,
  actor: Actor,
  playerId: string,
  endPower: number,
  until: Date,
  months: number,
  rand: () => number,
  now: Date,
) {
  let power = endPower;
  let furnace = 3 + Math.floor(rand() * 7);
  for (let m = 0; m < months; m++) {
    const at = new Date(until.getTime() - m * 30 * DAY - Math.floor(rand() * 5) * DAY);
    if (m > 0 && rand() < 0.15) continue; // skipped month
    await addImported(repo, actor, playerId, at, values(power, rand, furnace), now);
    power = Math.round(power / (1 + 0.02 + rand() * 0.07));
    if (rand() < 0.2) furnace = Math.max(1, furnace - 1);
  }
}

/** The standard demo set: 38 POP members, 2 guests, persona links, 3 reports each. */
export async function seedDemo(repo: Repository, now: Date, actor: Actor = { id: "seed", via: "seed" }) {
  const rand = prng(2612);
  const accounts: GameAccount[] = NAMES.map((name, i) =>
    parseNewAccount({ playerId: String(100000001 + i), name, rank: i === 9 ? "R5" : RANKS[i % RANKS.length] }),
  );
  accounts.push(
    parseNewAccount({ playerId: "200000001", name: "MirGuest", alliance: "MIR", status: "guest" }),
    parseNewAccount({ playerId: "200000002", name: "GoldGuest", alliance: "24K", status: "guest" }),
  );
  // Concurrently: a sequential loop here is the slowest part of every integration suite's setup.
  await inBatches(accounts, 8, async (a) => repo.createAccount(a, actor));
  for (const [sub, ids] of Object.entries(PERSONA_LINKS)) {
    for (const id of ids) await repo.linkAccount(sub, id, actor);
  }
  const members = accounts.filter((a) => a.status === "active");
  const powers = new Map(members.map((a) => [a.playerId, Math.round(20_000_000 + rand() * 80_000_000)]));
  await inBatches(members, 8, async (a) => {
    // Most members reported recently; about one in six is overdue.
    const lastReport = new Date(now.getTime() - (rand() < 0.17 ? 35 + rand() * 30 : rand() * 20) * DAY);
    await writeHistory(repo, actor, a.playerId, powers.get(a.playerId)!, lastReport, 3, prng(Number(a.playerId)), now);
  });
  return { accounts: accounts.length, members: members.length };
}

/** Adds `count` random new POP members, each with a few months of history. */
export async function addRandomMembers(repo: Repository, count: number, now: Date, actor: Actor) {
  const rand = prng(now.getTime() % 2 ** 31);
  const created: GameAccount[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = `${EXTRA_PARTS[Math.floor(rand() * EXTRA_PARTS.length)]}${EXTRA_ENDS[Math.floor(rand() * EXTRA_ENDS.length)]}${Math.floor(rand() * 90) + 10}`;
      const account = parseNewAccount({
        playerId: String(400000000 + Math.floor(rand() * 99_999_999)),
        name,
        rank: RANKS[Math.floor(rand() * RANKS.length)],
      });
      try {
        await repo.createAccount(account, actor);
        created.push(account);
        break;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }
  await inBatches(created, 8, async (a) => {
    const months = 2 + Math.floor(rand() * 6);
    await writeHistory(repo, actor, a.playerId, Math.round(15_000_000 + rand() * 90_000_000), now, months, prng(Number(a.playerId)), now);
  });
  return created;
}

/** Adds `months` of older monthly reports before an account's earliest report. */
export async function backfillHistory(repo: Repository, playerId: string, months: number, now: Date, actor: Actor) {
  const reports = await repo.listReports(playerId);
  const earliest = reports.toSorted((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))[0];
  const earliestPower = earliest?.values.find((v) => v.metric === "city_power")?.value;
  const startPower = typeof earliestPower === "number" ? earliestPower : 40_000_000;
  const until = earliest ? new Date(new Date(earliest.effectiveAt).getTime() - 30 * DAY) : now;
  const rand = prng(Number(playerId) + reports.length);
  await writeHistory(repo, actor, playerId, Math.round(startPower / 1.05), until, months, rand, now);
  return months;
}

/** Everyone who's active files a fresh report today, with realistic growth; a few don't bother. */
export async function everyoneReports(repo: Repository, now: Date, actor: Actor) {
  const members = (await repo.listAccounts("POP")).filter((a) => a.status === "active");
  const rand = prng(now.getTime() % 2 ** 31);
  let reported = 0;
  await inBatches(members, 8, async (a) => {
    if (rand() < 0.2) return;
    const reports = await repo.listReports(a.playerId);
    const last = reports
      .toSorted((x, y) => x.effectiveAt.localeCompare(y.effectiveAt))
      .at(-1)
      ?.values.find((v) => v.metric === "city_power")?.value;
    const base = typeof last === "number" ? last : 30_000_000;
    await addImported(repo, actor, a.playerId, now, values(Math.round(base * (1 + rand() * 0.06)), rand, 6), now);
    reported++;
  });
  return { members: members.length, reported };
}

/** Demo events a few days out, so the Events page has something to show locally. */
export async function addDemoEvents(repo: Repository, now: Date, actor: Actor): Promise<AllianceEvent[]> {
  const at = (days: number, hour: number) => {
    const d = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const planned = [
    {
      kind: "foundry" as const,
      title: "Foundry last week",
      startsAt: at(-1, 19),
      notes: "Completed demo event with a recorded result.",
      sessions: [{ id: "L1", label: "Legion 1", startsAt: at(-1, 19), starters: 30, subs: 10 }],
    },
    {
      kind: "foundry" as const,
      title: "Foundry Saturday",
      startsAt: at(6, 19),
      notes: "Two legions, be online 10 minutes early.",
      // The real shape: one event, a part per legion, 30 starters and 10 substitutes each.
      sessions: [
        { id: "L1", label: "Legion 1", startsAt: at(6, 12), starters: 30, subs: 10 },
        { id: "L2", label: "Legion 2", startsAt: at(6, 19), starters: 30, subs: 10 },
      ],
    },
    // Canyon is a plain "are you in?", so it has no parts: the demo covers the RSVP path.
    { kind: "canyon" as const, title: "Canyon", startsAt: at(1, 18) },
    {
      kind: "svs" as const,
      title: "SvS preparation call",
      startsAt: at(5, 12),
      notes: "Bring your buff wishes.",
      // SvS and FDT ask how much of it you can give, not which slot you take. Six hours from
      // 12:00 UTC, so the last half starts at 15:00.
      sessions: [
        { id: "full", label: "Full time", startsAt: at(5, 12) },
        { id: "first", label: "First half", startsAt: at(5, 12) },
        { id: "last", label: "Last half", startsAt: at(5, 15) },
      ],
    },
    {
      kind: "fdt" as const,
      title: "FDT",
      startsAt: at(3, 12),
      sessions: [
        { id: "full", label: "Full time", startsAt: at(3, 12) },
        { id: "first", label: "First half", startsAt: at(3, 12) },
        { id: "last", label: "Last half", startsAt: at(3, 15) },
      ],
    },
  ];
  const created: AllianceEvent[] = [];
  for (const input of planned) {
    // The completed fixture is created as historical demo data; live officer routes still refuse
    // creating events whose start is already in the past.
    const creationTime = Date.parse(input.startsAt) <= now.getTime()
      ? new Date(Date.parse(input.startsAt) - 24 * 60 * 60 * 1000)
      : now;
    const event = parseNewEvent(input, { eventId: ulid(now.getTime()), createdBy: actor.id, now: creationTime });
    await repo.createEvent(event, actor);
    if (event.kind === "foundry") {
      const session = event.sessions[0]!;
      const lineup = parseLineup(
        {
          entries: [
            { playerId: "100000001", role: "starter" },
            { playerId: "100000008", role: "starter" },
            { playerId: "100000010", role: "starter" },
            { playerId: "100000002", role: "sub" },
          ],
          note: "Demo decision: a small starting team and one substitute.",
        },
        session,
        { eventId: event.eventId, sessionId: session.id, publishedBy: actor.id, now, currentVersion: 0 },
      );
      await repo.putLineup(lineup, actor);
      const strategy = parseStrategy(
        {
          body: "**Opening plan**\n\n- Hold both prototypes\n- Join marked rallies\n\n**Final phase**\n\n- Farmers take weapon workshops",
          assignments: [
            { playerId: "100000001", role: "Holder", duty: "Prototype 1", note: "Lead marked rallies" },
            { playerId: "100000008", role: "Holder", duty: "Prototype 2" },
            { playerId: "100000010", role: "Farmer", duty: "Weapon workshops" },
            { playerId: "100000002", role: "Substitute Looter", duty: "Deploy after three minutes" },
          ],
        },
        session,
        { eventId: event.eventId, sessionId: session.id, publishedBy: actor.id, now, currentVersion: 0 },
      );
      await repo.putStrategy(strategy, actor);
      if (Date.parse(session.startsAt) <= now.getTime()) {
        const result = parseEventResult(
          {
            outcome: "win",
            ourScore: 1_240,
            opponentScore: 980,
            ourMatchmakingPower: 2_430_000_000,
            opponentMatchmakingPower: 2_510_000_000,
            opponentCombatants: 28,
            notes: "Demo result: prototypes held through the final phase.",
            playerPoints: [
              { playerId: "100000001", points: 52_400 },
              { playerId: "100000008", points: 48_900 },
            ],
          },
          session,
          { eventId: event.eventId, recordedBy: actor.id, now, currentVersion: 0 },
        );
        await repo.putResult(result, actor);

        // Who turned up. Without this the Attendance columns, the reliability score and the
        // six-month graphs are all dashes locally, and the Foundry ranking falls back to
        // strength alone — nothing like what the deployed app shows.
        const turnout: { playerId: string; status: "present" | "absent" | "excused" }[] = [
          { playerId: "100000001", status: "present" },
          { playerId: "100000008", status: "present" },
          { playerId: "100000010", status: "present" },
          { playerId: "100000002", status: "absent" },
          { playerId: "100000005", status: "excused" },
        ];
        for (const { playerId, status } of turnout) {
          await repo.setAttendance(
            { eventId: event.eventId, playerId, sessionId: session.id, status, source: "officer" },
            actor,
            new Date(Date.parse(session.startsAt) + 2 * 60 * 60 * 1000).toISOString(),
          );
        }
      }
    }
    created.push(event);
  }
  return created;
}

/** Random answers from active members, so officers can see counts and lists locally. */
export async function randomAnswers(repo: Repository, now: Date, actor: Actor) {
  const random = prng(now.getTime() & 0xffff);
  const events = (await repo.listEvents("POP", now.toISOString())).filter((e) => Date.parse(e.deadlineAt) > now.getTime());
  const accounts = (await repo.listAccounts("POP")).filter((a) => a.status === "active");
  let answered = 0;
  for (const event of events) {
    for (const account of accounts) {
      if (random() < 0.25) continue; // a quarter stay silent, like real life
      const answer = ANSWERS[random() < 0.7 ? 0 : random() < 0.5 ? 1 : 2] ?? "yes";
      // A yes for an event with parts has to name one, exactly like a real answer.
      const sessionId =
        answer === "yes" && event.sessions.length > 0
          ? event.sessions[Math.floor(random() * event.sessions.length)]!.id
          : undefined;
      await repo.setAnswer(event, account.playerId, { answer, ...(sessionId ? { sessionId } : {}) }, "player", actor);
      answered += 1;
    }
  }
  return { events: events.length, answers: answered };
}
