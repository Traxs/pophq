import { describe, expect, it } from "vitest";
import { applyTick, datedTasks, dueAt, parseTasks, STARTER_CHECKLISTS, type ChecklistEntry } from "./checklists.js";
import { ValidationError } from "./errors.js";

const event = {
  createdAt: "2026-09-20T09:00:00.000Z",
  deadlineAt: "2026-09-24T23:59:59.999Z",
  startsAt: "2026-09-27T19:00:00.000Z",
};

describe("dueAt", () => {
  it("hangs a job off the moment it belongs to", () => {
    expect(dueAt(event, { anchor: "answers_open", offsetHours: 0 })).toBe("2026-09-20T09:00:00.000Z");
    expect(dueAt(event, { anchor: "answers_close", offsetHours: -24 })).toBe("2026-09-23T23:59:59.999Z");
    expect(dueAt(event, { anchor: "start", offsetHours: -6 })).toBe("2026-09-27T13:00:00.000Z");
    expect(dueAt(event, { anchor: "start", offsetHours: 3 })).toBe("2026-09-27T22:00:00.000Z");
  });

  it("moves every job when the event moves", () => {
    const later = { ...event, startsAt: "2026-09-28T19:00:00.000Z" };
    expect(dueAt(later, { anchor: "start", offsetHours: -6 })).toBe("2026-09-28T13:00:00.000Z");
  });

  it("falls back to the deadline for an event with no creation time on record", () => {
    const old = { deadlineAt: event.deadlineAt, startsAt: event.startsAt };
    expect(dueAt(old, { anchor: "answers_open", offsetHours: 0 })).toBe(event.deadlineAt);
  });

  it("never opens answers after they closed, for an event entered or imported after the fact", () => {
    // Recorded a week after the battle: the sign-up jobs belong to the deadline, not to today.
    const late = { ...event, createdAt: "2026-10-04T12:00:00.000Z" };
    expect(dueAt(late, { anchor: "answers_open", offsetHours: 0 })).toBe(event.deadlineAt);
  });
});

describe("datedTasks", () => {
  const entries: ChecklistEntry[] = [
    { id: "call", label: "Post the sign-up call", anchor: "answers_open", offsetHours: 0 },
    { id: "deploy", label: "Set deployments", anchor: "start", offsetHours: -6 },
    { id: "attend", label: "Record who turned up", anchor: "start", offsetHours: 3 },
  ];

  it("orders jobs by when they are due, not by how they were written", () => {
    const tasks = datedTasks(event, [...entries].toReversed(), new Date("2026-09-21T00:00:00Z"));
    expect(tasks.map((t) => t.id)).toEqual(["call", "deploy", "attend"]);
  });

  it("calls a job due once its moment has passed", () => {
    const tasks = datedTasks(event, entries, new Date("2026-09-21T00:00:00Z"));
    expect(tasks.map((t) => `${t.id}:${t.state}`)).toEqual(["call:due", "deploy:upcoming", "attend:upcoming"]);
  });

  it("calls a job overdue once the battle started, but only the ones due beforehand", () => {
    const tasks = datedTasks(event, entries, new Date("2026-09-27T20:00:00Z"));
    // "attend" is due three hours after the start, so it has not even come round yet.
    expect(tasks.map((t) => `${t.id}:${t.state}`)).toEqual(["call:overdue", "deploy:overdue", "attend:upcoming"]);
  });

  it("keeps a job due after the battle as due however late it is, because it is still worth doing", () => {
    // Two days later: recording who turned up is late, but not a lost chance like a lineup.
    const tasks = datedTasks(event, entries, new Date("2026-09-29T20:00:00Z"));
    expect(tasks.map((t) => `${t.id}:${t.state}`)).toEqual(["call:overdue", "deploy:overdue", "attend:due"]);
  });

  it("leaves a ticked job alone however late it is", () => {
    const done = entries.map((e) => (e.id === "call" ? { ...e, doneAt: "2026-09-20T10:00:00Z", doneBy: "1" } : e));
    expect(datedTasks(event, done, new Date("2026-09-28T00:00:00Z"))[0]).toMatchObject({ id: "call", state: "done" });
  });
});

describe("applyTick", () => {
  const entries: ChecklistEntry[] = [{ id: "call", label: "Post the call", anchor: "answers_open", offsetHours: 0 }];
  const by = { playerId: "100000008", now: new Date("2026-09-20T10:00:00Z") };

  it("records who ticked it and when", () => {
    expect(applyTick({ entries }, "call", true, by)[0]).toMatchObject({
      doneAt: "2026-09-20T10:00:00.000Z",
      doneBy: "100000008",
    });
  });

  it("takes a tick back cleanly, leaving no trace on the task itself", () => {
    const done = applyTick({ entries }, "call", true, by);
    const undone = applyTick({ entries: done }, "call", false, by)[0]!;
    expect(undone.doneAt).toBeUndefined();
    expect(undone.doneBy).toBeUndefined();
    expect(undone.label).toBe("Post the call");
  });

  it("refuses a job that is not on this checklist", () => {
    expect(() => applyTick({ entries }, "nope", true, by)).toThrow(ValidationError);
  });
});

describe("parseTasks", () => {
  it("fills in ids and keeps what was written", () => {
    const tasks = parseTasks([
      { label: "  Post the call  ", anchor: "answers_open", offsetHours: 0 },
      { label: "Set deployments", anchor: "start", offsetHours: -6, note: "joiners and subs" },
    ]);
    expect(tasks[0]).toEqual({ id: "t1", label: "Post the call", anchor: "answers_open", offsetHours: 0 });
    expect(tasks[1]).toMatchObject({ id: "t2", note: "joiners and subs" });
  });

  it("refuses nonsense", () => {
    expect(() => parseTasks([{ label: "Hi", anchor: "start", offsetHours: 0 }])).toThrow(ValidationError);
    expect(() => parseTasks([{ label: "Valid job", anchor: "whenever", offsetHours: 0 }])).toThrow(ValidationError);
    expect(() => parseTasks([{ label: "Valid job", anchor: "start", offsetHours: 5000 }])).toThrow(ValidationError);
    expect(() =>
      parseTasks([
        { id: "same", label: "One job", anchor: "start", offsetHours: 0 },
        { id: "same", label: "Another", anchor: "start", offsetHours: 1 },
      ]),
    ).toThrow(/its own id/);
  });
});

describe("STARTER_CHECKLISTS", () => {
  it("covers running a Foundry from the sign-up call to recording attendance", () => {
    const foundry = STARTER_CHECKLISTS.foundry!;
    expect(foundry.map((t) => t.id)).toEqual(["call", "chase", "register", "lineup", "deploy", "attend"]);
    // Every starter job parses, so a type can be seeded from it without surprises.
    expect(parseTasks(foundry)).toHaveLength(foundry.length);
  });

  it("puts the jobs in the order they actually happen", () => {
    const tasks = datedTasks(event, parseTasks(STARTER_CHECKLISTS.foundry!), new Date("2026-09-20T09:00:00Z"));
    expect(tasks.map((t) => t.id)).toEqual(["call", "chase", "register", "lineup", "deploy", "attend"]);
  });
});
