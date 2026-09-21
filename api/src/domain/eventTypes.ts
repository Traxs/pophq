// Officer-defined event types (EVT-01). A type carries what every event of that kind needs:
// how long before the start answers close, which parts people choose between (Foundry legions,
// waves, lanes) and a strategy template. Creating an event picks a type and inherits all of it,
// and the officer can still change any of it for that one event.
import { z } from "zod";
import { ChecklistTemplateSchema, parseTasks, STARTER_CHECKLISTS, type ChecklistTask } from "./checklists.js";
import { ValidationError } from "./errors.js";

export interface EventTypeSession {
  id: string;
  label: string;
  /** Usual start, as minutes after midnight in the alliance's day; the officer sets the date. */
  defaultMinutes?: number;
}

export interface EventType {
  typeId: string;
  name: string;
  /** Whole days before the start when answers close; 0 means an hour before. */
  leadDays: number;
  sessions: EventTypeSession[];
  strategyTemplate?: string;
  /** The jobs an officer works through when running one of these (the legacy checklist, timed). */
  checklist?: ChecklistTask[];
  archived: boolean;
  createdBy: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,23}$/;

const SessionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,8}$/, "Part id must be 1–8 letters, digits, - or _.")
    .optional(),
  label: z.string().trim().min(1, "Every part needs a name.").max(30),
  defaultMinutes: z.number().int().min(0).max(24 * 60 - 1).optional(),
});

const EventTypeSchema = z.object({
  typeId: z.string().trim().toLowerCase().regex(SLUG, "Use 2–24 lowercase letters, digits or dashes.").optional(),
  name: z.string().trim().min(2, "Name must be 2–40 characters.").max(40),
  leadDays: z.number().int().min(0).max(60).default(0),
  sessions: z.array(SessionSchema).max(6, "At most six parts.").default([]),
  strategyTemplate: z.string().trim().max(10_000).optional(),
  checklist: ChecklistTemplateSchema.optional(),
  archived: z.boolean().default(false),
});

/** "Foundry Saturday" -> "foundry-saturday", so an officer never has to invent an id. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!SLUG.test(slug)) throw new ValidationError("Give the type a name with letters or digits.");
  return slug;
}

export function parseEventType(input: unknown, createdBy: string): EventType {
  const parsed = EventTypeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid event type.", z.flattenError(parsed.error).fieldErrors);
  const { typeId, sessions, strategyTemplate, checklist, ...rest } = parsed.data;
  const withIds = sessions.map((s, i) => ({
    id: s.id ?? `S${i + 1}`,
    label: s.label,
    ...(s.defaultMinutes === undefined ? {} : { defaultMinutes: s.defaultMinutes }),
  }));
  if (new Set(withIds.map((s) => s.id)).size !== withIds.length) throw new ValidationError("Each part needs its own id.");
  return {
    typeId: typeId ?? slugify(rest.name),
    ...rest,
    sessions: withIds,
    ...(strategyTemplate ? { strategyTemplate } : {}),
    ...(checklist ? { checklist: parseTasks(checklist) } : {}),
    createdBy,
  };
}

/**
 * The types an alliance starts with, matching how POP plays today. They are ordinary types:
 * officers can rename them, change their lead time, parts and template, or archive them.
 */
export const STARTER_TYPES: readonly Omit<EventType, "createdBy">[] = [
  {
    typeId: "foundry",
    name: "Foundry",
    leadDays: 3,
    sessions: [
      { id: "L1", label: "Legion 1", defaultMinutes: 12 * 60 },
      { id: "L2", label: "Legion 2", defaultMinutes: 19 * 60 },
    ],
    strategyTemplate: "## Plan\n\n- \n\n## Who does what\n\n- ",
    checklist: STARTER_CHECKLISTS.foundry!,
    archived: false,
  },
  // SvS and FDT ask how much of the event someone can give, not which time slot they take.
  // The three answers are ordinary parts: a member picks exactly one, or says they can't come.
  // Both normally run six hours from 12:00 UTC, so the last half starts at 15:00.
  {
    typeId: "svs",
    name: "SvS",
    leadDays: 3,
    sessions: [
      { id: "full", label: "Full time", defaultMinutes: 12 * 60 },
      { id: "first", label: "First half", defaultMinutes: 12 * 60 },
      { id: "last", label: "Last half", defaultMinutes: 15 * 60 },
    ],
    checklist: STARTER_CHECKLISTS.svs!,
    archived: false,
  },
  {
    typeId: "fdt",
    name: "FDT",
    leadDays: 1,
    sessions: [
      { id: "full", label: "Full time", defaultMinutes: 12 * 60 },
      { id: "first", label: "First half", defaultMinutes: 12 * 60 },
      { id: "last", label: "Last half", defaultMinutes: 15 * 60 },
    ],
    checklist: STARTER_CHECKLISTS.fdt!,
    archived: false,
  },
  // Canyon and Tundra League are a simple "are you in?", so they carry no parts.
  { typeId: "canyon", name: "Canyon", leadDays: 1, sessions: [], archived: false },
  { typeId: "tundra", name: "Tundra League", leadDays: 1, sessions: [], archived: false },
  // The Bear hunt runs every other day and needs no sign-up; it is kept, archived, so past bear
  // events still have their type behind them.
  { typeId: "bear", name: "Bear hunt", leadDays: 0, sessions: [], archived: true },
  { typeId: "other", name: "Other", leadDays: 0, sessions: [], archived: false },
];
