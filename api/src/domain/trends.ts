// Trailing monthly trends for the small in-table graphs (MET-02). Months with nothing to say
// are null rather than zero: a member who was not checked in March did not "score 0%", and a
// month without a report is not a power of zero.
import type { AttendanceRecord } from "./attendance.js";

/** Month keys, oldest first, e.g. ["2026-04", … "2026-09"] for six months ending now. */
export function monthsEnding(now: Date, months = 6): string[] {
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

const monthOf = (iso: string): string => iso.slice(0, 7);

/**
 * One value per month: the last value seen in that month, carried forward from earlier months
 * so a flat line means "unchanged", not "missing". Months before the first value stay null.
 */
export function monthlyValues(
  points: readonly { at: string; value: number }[],
  now: Date,
  months = 6,
): (number | null)[] {
  const ordered = [...points].toSorted((a, b) => a.at.localeCompare(b.at));
  const keys = monthsEnding(now, months);
  const out: (number | null)[] = [];
  let carried: number | null = null;
  let index = 0;
  for (const key of keys) {
    while (index < ordered.length && monthOf(ordered[index]!.at) <= key) {
      carried = ordered[index]!.value;
      index += 1;
    }
    out.push(carried);
  }
  return out;
}

/**
 * Share of kept commitments per month, 0–1, or null for a month in which nothing was checked.
 * Excused absences and unknown records are left out of both sides of the ratio.
 */
export function monthlyAttendance(
  records: readonly Pick<AttendanceRecord, "status" | "recordedAt">[],
  now: Date,
  months = 6,
): (number | null)[] {
  const counted = records.filter((r) => r.status === "present" || r.status === "absent");
  return monthsEnding(now, months).map((key) => {
    const inMonth = counted.filter((r) => monthOf(r.recordedAt) === key);
    if (inMonth.length === 0) return null;
    return inMonth.filter((r) => r.status === "present").length / inMonth.length;
  });
}

/**
 * Smooths a monthly series into a trailing average: each point is the average of that month
 * and the `window - 1` months before it, counting only months that had something to say.
 * A month with nothing in its whole window stays null rather than inventing a value.
 */
export function trailingAverage(values: readonly (number | null)[], window = 3): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v !== null);
    if (slice.length === 0) return null;
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  });
}
