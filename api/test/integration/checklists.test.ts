import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { createHarness, type Harness } from "./harness.js";

const OFFICER = { as: "officer", groups: ["officer"] };
const PLAYER = { as: "player", headers: { "x-account-id": "100000001" } };

const inDays = (days: number, hour = 19) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

interface Task {
  id: string;
  label: string;
  dueAt: string;
  state: string;
  doneBy?: string;
}

describe("event checklists", () => {
  let h: Harness;
  let eventId: string;

  beforeAll(async () => {
    h = await createHarness();
    await seedDemo(h.repo, new Date());
    const res = await h.call("POST", "/events", {
      ...OFFICER,
      body: { kind: "foundry", title: "Foundry Saturday", startsAt: inDays(10), ownerPlayerId: "100000008" },
    });
    expect(res.status).toBe(201);
    eventId = res.body.eventId as string;
  });
  afterAll(() => h.cleanup());

  const tasksOf = async () => {
    const res = await h.call("GET", `/events/${eventId}`, OFFICER);
    return (res.body.checklist as { version: number; tasks: Task[] } | undefined) ?? { version: 0, tasks: [] };
  };

  it("gives a new Foundry the jobs its type carries, in the order they happen", async () => {
    const { tasks } = await tasksOf();
    expect(tasks.map((t) => t.id)).toEqual(["call", "chase", "register", "lineup", "deploy", "attend"]);
    // The sign-up call is due as soon as the event exists; the rest are still ahead.
    expect(tasks[0]).toMatchObject({ state: "due" });
    expect(tasks.at(-1)).toMatchObject({ state: "upcoming" });
  });

  it("names the officer who runs it", async () => {
    const res = await h.call("GET", `/events/${eventId}`, OFFICER);
    expect(res.body).toMatchObject({ ownerPlayerId: "100000008", ownerName: "Aurora" });
  });

  it("keeps the checklist to officers", async () => {
    const res = await h.call("GET", `/events/${eventId}`, PLAYER);
    expect(res.status).toBe(200);
    expect(res.body.checklist).toBeUndefined();
    expect(
      (await h.call("PUT", `/events/${eventId}/checklist/call`, { ...PLAYER, body: { done: true } })).status,
    ).toBe(403);
  });

  it("records who ticked a job, and lets the tick be taken back", async () => {
    const ticked = await h.call("PUT", `/events/${eventId}/checklist/call`, { ...OFFICER, body: { done: true } });
    expect(ticked.status).toBe(200);
    const done = (ticked.body.tasks as Task[]).find((t) => t.id === "call")!;
    expect(done).toMatchObject({ state: "done", doneBy: "100000008" });

    const undone = await h.call("PUT", `/events/${eventId}/checklist/call`, { ...OFFICER, body: { done: false } });
    const back = (undone.body.tasks as Task[]).find((t) => t.id === "call")!;
    expect(back.state).toBe("due");
    expect(back.doneBy).toBeUndefined();
  });

  it("refuses a job that is not on the list, and an event that has none", async () => {
    expect((await h.call("PUT", `/events/${eventId}/checklist/nope`, { ...OFFICER, body: { done: true } })).status).toBe(400);
    const plain = await h.call("POST", "/events", {
      ...OFFICER,
      body: { kind: "canyon", title: "Canyon", startsAt: inDays(4) },
    });
    expect(
      (await h.call("PUT", `/events/${plain.body.eventId}/checklist/call`, { ...OFFICER, body: { done: true } })).status,
    ).toBe(404);
  });

  it("lists what officers still have to do, theirs first", async () => {
    const res = await h.call("GET", "/officer-jobs", OFFICER);
    expect(res.status).toBe(200);
    const jobs = res.body.items as { taskId: string; mine: boolean; eventTitle: string; dueAt: string }[];
    expect(jobs.length).toBeGreaterThan(0);
    // The officer is acting as Aurora, who owns this event.
    expect(jobs[0]).toMatchObject({ eventTitle: "Foundry Saturday", mine: true });
    // Only jobs whose moment has come: nothing still in the future.
    expect(jobs.every((j) => Date.parse(j.dueAt) <= Date.now())).toBe(true);
  });

  it("drops a job off the list once it is ticked", async () => {
    const before = (await h.call("GET", "/officer-jobs", OFFICER)).body.items as { taskId: string }[];
    await h.call("PUT", `/events/${eventId}/checklist/call`, { ...OFFICER, body: { done: true } });
    const after = (await h.call("GET", "/officer-jobs", OFFICER)).body.items as { taskId: string }[];
    expect(after.length).toBe(before.length - 1);
  });

  it("keeps members out of the officers' job list", async () => {
    expect((await h.call("GET", "/officer-jobs", PLAYER)).status).toBe(403);
  });

  it("moves every job when the event moves", async () => {
    const before = (await tasksOf()).tasks.find((t) => t.id === "deploy")!;
    await h.call("PATCH", `/events/${eventId}`, { ...OFFICER, body: { startsAt: inDays(12) } });
    const after = (await tasksOf()).tasks.find((t) => t.id === "deploy")!;
    expect(Date.parse(after.dueAt) - Date.parse(before.dueAt)).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("hands an event back to nobody when the owner is cleared", async () => {
    await h.call("PATCH", `/events/${eventId}`, { ...OFFICER, body: { ownerPlayerId: "" } });
    const res = await h.call("GET", `/events/${eventId}`, OFFICER);
    expect(res.body.ownerPlayerId).toBeUndefined();
    expect(res.body.ownerName).toBeNull();
  });
});
