import type { EventKind, EventListItem, OfficerJob, SvsRoundListItem } from "./api";
import { eventDayTime } from "./format";
import { REPORT_DUE_DAYS } from "./rules";

export type HomePriorityTier = 0 | 1 | 2 | 3 | 4 | 5;
export type HomePriorityKind = "event-response" | "upcoming-event" | "ministry-booking" | "ministry-appointment" | "power" | "troops" | "officer";

export interface HomePriorityCandidate {
  id: string;
  kind: HomePriorityKind;
  tier: HomePriorityTier;
  section: "attention" | "upcoming";
  title: string;
  detail: string;
  href: string;
  icon: string;
  at?: string;
  actionLabel?: string;
}

export interface HomePriorityInput {
  events: readonly EventListItem[];
  round: SvsRoundListItem | null;
  latestPowerAt?: string;
  powerLoaded: boolean;
  missingTroopDetails?: readonly string[];
  officerJobs: readonly OfficerJob[];
  now: Date;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EVENT_NAMES: Record<EventKind, string> = {
  foundry: "Foundry",
  svs: "SvS",
  koi: "King of Icefield",
  fdt: "FDT",
  canyon: "Canyon",
  tundra: "Tundra League",
  bear: "Bear hunt",
  other: "Alliance event",
};
const MINISTRY_NAMES = {
  construction: "Vice President · Construction",
  research: "Vice President · Research",
  training: "Minister of Education · Troop training",
} as const;

export function homePriorities(input: HomePriorityInput): HomePriorityCandidate[] {
  const now = input.now.getTime();
  const candidates: HomePriorityCandidate[] = [];

  for (const event of input.events) {
    const startsIn = Date.parse(event.startsAt) - now;
    if (startsIn < -6 * HOUR) continue;
    const eventName = EVENT_NAMES[event.kind];
    if (!event.closed && event.myAnswer === null && startsIn >= 0) {
      const closesIn = Date.parse(event.deadlineAt) - now;
      const tier: HomePriorityTier = closesIn <= DAY ? 1 : closesIn <= 3 * DAY ? 3 : 4;
      candidates.push({
        id: `event-response:${event.eventId}`,
        kind: "event-response",
        tier,
        section: "attention",
        title: `Register for ${eventName}`,
        detail: closesIn <= 0 ? "Answers are closing now" : `Answers close ${distance(closesIn)}`,
        href: `/events/${event.eventId}`,
        icon: "!",
        at: event.deadlineAt,
        actionLabel: "Choose attendance",
      });
      continue;
    }
    if ((event.myAnswer === "yes" || event.myAnswer === "maybe") && startsIn >= 0) {
      const session = event.sessions.find((item) => item.id === event.mySessionId);
      const imminent = startsIn <= 2 * HOUR;
      candidates.push({
        id: `upcoming-event:${event.eventId}`,
        kind: "upcoming-event",
        tier: imminent ? 2 : 5,
        section: imminent ? "attention" : "upcoming",
        title: imminent ? `${eventName} starts ${distance(startsIn)}` : eventName,
        detail: session ? `${session.label} · ${eventDayTime(event.startsAt)}` : eventDayTime(event.startsAt),
        href: `/events/${event.eventId}`,
        icon: "◷",
        at: event.startsAt,
        ...(imminent ? { actionLabel: "Open event" } : {}),
      });
    }
  }

  if (input.round?.bookingEnabled && input.round.nextBooking) {
    const booking = input.round.nextBooking;
    const startsIn = Date.parse(booking.startsAt) - now;
    const active = startsIn <= 0 && startsIn > -30 * 60 * 1000;
    const imminent = startsIn > 0 && startsIn <= 2 * HOUR;
    candidates.push({
      id: `ministry-appointment:${booking.bookingId}`,
      kind: "ministry-appointment",
      tier: active ? 0 : imminent ? 2 : startsIn <= DAY ? 3 : 5,
      section: active || imminent ? "attention" : "upcoming",
      title: active ? "Your Ministry appointment is now" : imminent ? `Ministry starts ${distance(startsIn)}` : "Ministry appointment",
      detail: `${MINISTRY_NAMES[booking.buff]} · ${calendarTime(booking.startsAt)}`,
      href: `/svs/${input.round.roundId}`,
      icon: active ? "●" : "♔",
      at: booking.startsAt,
      ...(active || imminent ? { actionLabel: "Open appointment" } : {}),
    });
  } else if (input.round?.bookingEnabled && !input.round.answered) {
    const endsIn = input.round.term ? Date.parse(`${input.round.term.endsOn}T23:59:59.999Z`) - now : 7 * DAY;
    candidates.push({
      id: `ministry-booking:${input.round.roundId}`,
      kind: "ministry-booking",
      tier: endsIn <= 3 * DAY ? 3 : 4,
      section: "attention",
      title: "Book a Ministry appointment",
      detail: endsIn <= 3 * DAY ? `This term closes ${distance(endsIn)}` : "Pick any free half-hour slot",
      href: `/svs/${input.round.roundId}`,
      icon: "♔",
      ...(input.round.term ? { at: `${input.round.term.endsOn}T23:59:59.999Z` } : {}),
      actionLabel: "Choose a time",
    });
  }

  if (input.powerLoaded) {
    if (!input.latestPowerAt) {
      candidates.push({ id: "power:first", kind: "power", tier: 1, section: "attention", title: "Submit your first power report", detail: "It takes about 30 seconds", href: "/power?update=1", icon: "!", actionLabel: "Report power" });
    } else {
      const age = now - Date.parse(input.latestPowerAt);
      const daysOld = Math.floor(age / DAY);
      if (daysOld >= REPORT_DUE_DAYS - 3) candidates.push({
        id: "power:due",
        kind: "power",
        tier: daysOld >= REPORT_DUE_DAYS ? 1 : 3,
        section: "attention",
        title: daysOld >= REPORT_DUE_DAYS ? "Power report due" : "Power report due soon",
        detail: `Last report was ${daysOld} ${daysOld === 1 ? "day" : "days"} ago`,
        href: "/power?update=1",
        icon: "⚡",
        actionLabel: "Update power",
      });
    }
  }

  const upcomingSvs = input.events
    .filter((event) => event.kind === "svs" && event.myAnswer !== "no" && Date.parse(event.startsAt) >= now)
    .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  if (upcomingSvs && input.missingTroopDetails && input.missingTroopDetails.length > 0) {
    const startsIn = Date.parse(upcomingSvs.startsAt) - now;
    const shown = input.missingTroopDetails.slice(0, 3);
    const remainder = input.missingTroopDetails.length - shown.length;
    candidates.push({
      id: `troops:${upcomingSvs.eventId}`,
      kind: "troops",
      tier: startsIn <= 3 * DAY ? 2 : 3,
      section: "attention",
      title: "Update your SvS troop details",
      detail: `Missing ${shown.join(", ")}${remainder > 0 ? ` +${remainder} more` : ""}`,
      href: "/power?update=1",
      icon: "⚔",
      at: upcomingSvs.startsAt,
      actionLabel: "Update troops",
    });
  }

  for (const job of input.officerJobs) {
    const dueIn = Date.parse(job.dueAt) - now;
    candidates.push({
      id: `officer:${job.eventId}:${job.taskId}`,
      kind: "officer",
      tier: dueIn <= 0 ? 0 : dueIn <= DAY ? 1 : dueIn <= 3 * DAY ? 3 : 4,
      section: "attention",
      title: job.label,
      detail: `${job.eventTitle} · ${dueIn <= 0 ? "overdue" : `due ${distance(dueIn)}`}${!job.mine && job.ownerName ? ` · ${job.ownerName}'s` : !job.mine ? " · unassigned" : ""}`,
      href: `/events/${job.eventId}`,
      icon: "○",
      at: job.dueAt,
      actionLabel: "Open task",
    });
  }

  return candidates.toSorted(comparePriority);
}

export function comparePriority(a: HomePriorityCandidate, b: HomePriorityCandidate): number {
  return a.tier - b.tier || timeOf(a) - timeOf(b) || a.id.localeCompare(b.id);
}

const timeOf = (candidate: HomePriorityCandidate) => candidate.at ? Date.parse(candidate.at) : Number.MAX_SAFE_INTEGER;

export function distance(milliseconds: number): string {
  if (milliseconds <= 0) return "now";
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(milliseconds / HOUR);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(milliseconds / DAY);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

const calendarTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
