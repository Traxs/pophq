/**
 * Event checklists (the legacy app's `events.checklist`, with times and an owner).
 *
 * Running a Foundry is a sequence of jobs that each come due at their own moment: call for
 * sign-ups when answers open, chase the silent ones before they close, publish the lineup, fix
 * everyone's deployment before the battle. So a task hangs off one of the event's own moments
 * rather than a fixed date — move the event and every task moves with it.
 *
 * One officer owns an event and Home tells them what is theirs, but any officer may tick a task:
 * jobs still have to get done when the owner is asleep, and the tick records who did it.
 */
import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { AllianceEvent } from "./events.js";

/** The moments a task can hang off. */
export const ANCHORS = ["answers_open", "answers_close", "start"] as const;
export type Anchor = (typeof ANCHORS)[number];

export interface ChecklistTask {
  /** Stable within the event, so ticking survives an edit of the wording. */
  id: string;
  label: string;
  anchor: Anchor;
  /** Hours from the anchor; negative is before it. */
  offsetHours: number;
  note?: string;
}

export interface ChecklistEntry extends ChecklistTask {
  doneAt?: string;
  /** The game account of whoever ticked it, which is not always the owner. */
  doneBy?: string;
}

export interface Checklist {
  eventId: string;
  /** Bumped on every tick, so two officers cannot overwrite each other. */
  version: number;
  entries: ChecklistEntry[];
  updatedAt: string;
}

const TaskSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,24}$/, "Task id must be 1–24 letters, digits, - or _.")
    .optional(),
  label: z.string().trim().min(3, "Say what the job is.").max(120),
  anchor: z.enum(ANCHORS),
  offsetHours: z.number().int().min(-720, "At most 30 days either side.").max(720, "At most 30 days either side."),
  note: z.string().trim().max(200).optional(),
});

export const ChecklistTemplateSchema = z.array(TaskSchema).max(20, "At most twenty jobs.");

export function parseTasks(input: unknown): ChecklistTask[] {
  const parsed = ChecklistTemplateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid checklist.", z.flattenError(parsed.error).fieldErrors);
  const tasks = parsed.data.map((task, index) => ({
    id: task.id ?? `t${index + 1}`,
    label: task.label,
    anchor: task.anchor,
    offsetHours: task.offsetHours,
    ...(task.note ? { note: task.note } : {}),
  }));
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new ValidationError("Each job needs its own id.");
  return tasks;
}

/**
 * When a task comes due. "Answers open" is the moment the event was created, because that is when
 * members can first answer — but never later than the deadline. An event entered after the fact,
 * or imported from the old data, was created long after answers would have opened, and without
 * the clamp its sign-up jobs would fall due after the battle they belong to.
 */
export function dueAt(
  event: Pick<AllianceEvent, "startsAt" | "deadlineAt"> & { createdAt?: string },
  task: Pick<ChecklistTask, "anchor" | "offsetHours">,
): string {
  const openedAt =
    event.createdAt && Date.parse(event.createdAt) < Date.parse(event.deadlineAt)
      ? event.createdAt
      : event.deadlineAt;
  const anchors: Record<Anchor, string> = {
    answers_open: openedAt,
    answers_close: event.deadlineAt,
    start: event.startsAt,
  };
  return new Date(Date.parse(anchors[task.anchor]) + task.offsetHours * 60 * 60 * 1000).toISOString();
}

export type TaskState = "done" | "overdue" | "due" | "upcoming";

export interface DatedTask extends ChecklistEntry {
  dueAt: string;
  state: TaskState;
}

/**
 * The checklist as it stands now: every job with the moment it is due and where it has got to.
 *
 * "Overdue" means the chance has gone, not merely that the job is late. Only a job due before the
 * battle can miss its chance — publishing a lineup after the fighting is pointless. A job due
 * afterwards, like recording who turned up, stays "due" however late it is, because it is still
 * worth doing.
 */
export function datedTasks(
  event: Pick<AllianceEvent, "startsAt" | "deadlineAt"> & { createdAt?: string },
  entries: readonly ChecklistEntry[],
  now: Date,
): DatedTask[] {
  return entries
    .map((entry) => {
      const due = dueAt(event, entry);
      const started = now.getTime() >= Date.parse(event.startsAt);
      const beforeTheEvent = Date.parse(due) < Date.parse(event.startsAt);
      const state: TaskState = entry.doneAt
        ? "done"
        : Date.parse(due) > now.getTime()
          ? "upcoming"
          : started && beforeTheEvent
            ? "overdue"
            : "due";
      return { ...entry, dueAt: due, state };
    })
    .toSorted((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** Applies a tick, or takes one back. The task must exist; the event's own rules live above. */
export function applyTick(
  checklist: Pick<Checklist, "entries">,
  taskId: string,
  done: boolean,
  by: { playerId: string; now: Date },
): ChecklistEntry[] {
  if (!checklist.entries.some((e) => e.id === taskId)) throw new ValidationError("That job isn't on this checklist.");
  return checklist.entries.map((entry) => {
    if (entry.id !== taskId) return entry;
    // Rebuilt from the task's own fields, so taking a tick back leaves nothing behind.
    const task: ChecklistEntry = {
      id: entry.id,
      label: entry.label,
      anchor: entry.anchor,
      offsetHours: entry.offsetHours,
      ...(entry.note ? { note: entry.note } : {}),
    };
    return done ? { ...task, doneAt: by.now.toISOString(), doneBy: by.playerId } : task;
  });
}

/**
 * The starting checklist for each type, written from how POP actually runs these events. They are
 * ordinary templates: officers change them per type, or per event once it exists.
 */
export const STARTER_CHECKLISTS: Partial<Record<string, ChecklistTask[]>> = {
  foundry: [
    { id: "call", label: "Post the sign-up call in Discord", anchor: "answers_open", offsetHours: 0 },
    { id: "chase", label: "Chase anyone who hasn't answered", anchor: "answers_close", offsetHours: -24 },
    { id: "register", label: "Register the participants in game", anchor: "answers_close", offsetHours: 1 },
    { id: "lineup", label: "Publish the lineup for both legions", anchor: "answers_close", offsetHours: 2 },
    { id: "deploy", label: "Set everyone's deployment — starters and subs", anchor: "start", offsetHours: -6 },
    { id: "attend", label: "Record who turned up", anchor: "start", offsetHours: 3 },
  ],
  svs: [
    { id: "call", label: "Post the sign-up call in Discord", anchor: "answers_open", offsetHours: 0 },
    { id: "chase", label: "Chase anyone who hasn't answered", anchor: "answers_close", offsetHours: -24 },
    { id: "buffs", label: "Check the buff slots are published", anchor: "start", offsetHours: -24 },
    { id: "attend", label: "Record who turned up", anchor: "start", offsetHours: 7 },
  ],
  fdt: [
    { id: "call", label: "Post the sign-up call in Discord", anchor: "answers_open", offsetHours: 0 },
    { id: "chase", label: "Chase anyone who hasn't answered", anchor: "answers_close", offsetHours: -12 },
    { id: "attend", label: "Record who turned up", anchor: "start", offsetHours: 7 },
  ],
};
