import type { EventKind } from "./api";

export interface DraftEventSession {
  id?: string;
  label: string;
  startsAt: string;
}

/** Foundry and Canyon are each one event with two mutually exclusive battle times. */
export const isLegionEvent = (kind: EventKind): boolean => kind === "foundry" || kind === "canyon";

const AVAILABILITY_SESSIONS: readonly DraftEventSession[] = [
  { id: "full", label: "Full time", startsAt: "" },
  { id: "first", label: "First half", startsAt: "" },
  { id: "last", label: "Last half", startsAt: "" },
];

export function defaultEventSessions(kind: EventKind): DraftEventSession[] {
  if (isLegionEvent(kind)) {
    return [
      { id: "L1", label: "Legion 1", startsAt: "" },
      { id: "L2", label: "Legion 2", startsAt: "" },
    ];
  }
  return kind === "svs" || kind === "koi" || kind === "fdt"
    ? AVAILABILITY_SESSIONS.map((session) => ({ ...session }))
    : [];
}
