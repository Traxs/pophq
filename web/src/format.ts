// Display helpers. Pure functions, unit-tested in format.test.ts.

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat("en-US");

/** 45123456 -> "45.1M" */
export const compact = (n: number): string => compactFmt.format(n);

/** 45123456 -> "45,123,456"; strings pass through. */
export const full = (v: number | string): string => (typeof v === "number" ? fullFmt.format(v) : v);

/** Keeps only digits and reformats with thousands separators while typing: "45000000" -> "45,000,000". */
export function formatDigitsInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits === "" ? "" : fullFmt.format(Number(digits));
}

/** Parses a formatted number field; undefined when empty. */
export function parseDigits(raw: string): number | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits === "" ? undefined : Number(digits);
}

export interface Change {
  absolute: number;
  percent: number;
  direction: "up" | "down" | "flat";
}

/** Change from previous to current; undefined without a usable baseline (never shown as 0%). */
export function change(current: number, previous: number | undefined): Change | undefined {
  if (previous === undefined || previous <= 0) return undefined;
  const absolute = current - previous;
  const percent = (absolute / previous) * 100;
  return { absolute, percent, direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat" };
}

/** Days between two instants, rounded down. */
export const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** "today", "yesterday", "5 days ago", "3 weeks ago", "2 months ago" */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const d = daysBetween(new Date(iso), now);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

/** "Sep 13, 2026" in the viewer's locale. */
export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Initials for an avatar: "IceQueen" -> "IQ", "poppy" -> "PO". */
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Sat 21 Sep, 19:00" in the reader's own time zone. */
export const dayTime = (iso: string): string => dayTimeFmt.format(new Date(iso));

/** Rough, friendly distance to a moment: "in 3 days", "in 4 h", "in 20 min", "now". */
export function untilText(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function initials(name: string): string {
  const caps = name.match(/\p{Lu}/gu);
  if (caps && caps.length >= 2) return (caps[0]! + caps[1]!).toUpperCase();
  return [...name].slice(0, 2).join("").toUpperCase();
}
