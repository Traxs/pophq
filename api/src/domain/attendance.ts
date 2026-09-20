// Who actually turned up (EVT-07). Recorded per game account and per part of the event, so a
// Foundry records Legion 1 and Legion 2 separately. Attendance is evidence, not a guess:
// "unknown" is a real answer and never counts against anyone.
import { z } from "zod";
import { ValidationError } from "./errors.js";

export const ATTENDANCE_STATUSES = ["present", "absent", "excused", "unknown"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Where the record comes from; a screenshot outranks a memory when they disagree. */
export const ATTENDANCE_SOURCES = ["officer", "screenshot", "agent", "import"] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export interface AttendanceRecord {
  eventId: string;
  playerId: string;
  sessionId?: string;
  status: AttendanceStatus;
  source: AttendanceSource;
  recordedAt: string;
  note?: string;
  /** Evidence this came from, e.g. a battle screenshot. */
  evidenceRef?: string;
}

const Schema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  sessionId: z.string().trim().max(8).optional(),
  note: z.string().trim().max(200).optional(),
  evidenceRef: z.string().trim().max(200).optional(),
});

export function parseAttendance(input: unknown): Pick<AttendanceRecord, "status" | "sessionId" | "note" | "evidenceRef"> {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Attendance must be one of: ${ATTENDANCE_STATUSES.join(", ")}.`, z.flattenError(parsed.error).fieldErrors);
  }
  const { status, sessionId, note, evidenceRef } = parsed.data;
  return {
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(note ? { note } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
  };
}

export interface Reliability {
  /** Kept commitments ÷ commitments that were checked, 0–1; undefined when nothing is known. */
  rate?: number;
  kept: number;
  missed: number;
  excused: number;
  /** How many events the rate is based on. */
  sample: number;
}

/**
 * How reliable someone is, from their attendance records, newest first, over the last
 * `window` records that were actually checked.
 *
 * Only "present" and "absent" count. "Excused" (told an officer in advance) and "unknown"
 * (nobody checked) are reported but never lower the rate: the score must not punish a member
 * for a missing screenshot.
 */
export function reliabilityOf(
  records: readonly Pick<AttendanceRecord, "status" | "recordedAt">[],
  window = 10,
): Reliability {
  const ordered = [...records].toSorted((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const counted = ordered.filter((r) => r.status === "present" || r.status === "absent").slice(0, window);
  const kept = counted.filter((r) => r.status === "present").length;
  const missed = counted.length - kept;
  const excused = ordered.filter((r) => r.status === "excused").length;
  return {
    ...(counted.length > 0 ? { rate: kept / counted.length } : {}),
    kept,
    missed,
    excused,
    sample: counted.length,
  };
}
