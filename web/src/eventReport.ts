import type { AttendanceStatus, EventDetail, EventMember } from "./api";

export type CompletedAttendance = "present" | "absent" | "excused" | "unrecorded";

export interface CompletedEventRow {
  member: EventMember;
  attendance: CompletedAttendance;
  attendanceEvidence: "score" | "record" | null;
  answerLabel: string;
  lineupLabel: string | null;
  sessionScores: { sessionId: string; label: string; points: number }[];
  preparationPoints: number | null;
  castleBattlePoints: number | null;
  hasEventRecord: boolean;
}

const attendanceOf = (status: AttendanceStatus | null): CompletedAttendance =>
  status === "present" || status === "absent" || status === "excused" ? status : "unrecorded";

/** Builds the completed-event ledger without turning missing evidence into an absence. */
export function completedEventRows(event: EventDetail): CompletedEventRow[] {
  const sessionLabels = new Map(event.sessions.map((session) => [session.id, session.label]));
  const resultScores = new Map<string, CompletedEventRow["sessionScores"]>();
  for (const session of event.sessions) {
    for (const score of session.result?.playerPoints ?? []) {
      const rows = resultScores.get(score.playerId) ?? [];
      rows.push({ sessionId: session.id, label: session.label, points: score.points });
      resultScores.set(score.playerId, rows);
    }
  }
  const preparation = new Map(event.scoreboards?.preparation.entries.map((entry) => [entry.playerId, entry.points]) ?? []);
  const battle = new Map(event.scoreboards?.castle_battle.entries.map((entry) => [entry.playerId, entry.points]) ?? []);

  const rows = (event.members ?? []).map((member): CompletedEventRow => {
    const sessionScores = resultScores.get(member.playerId) ?? [];
    const preparationPoints = preparation.get(member.playerId) ?? null;
    const castleBattlePoints = battle.get(member.playerId) ?? null;
    const positiveScore = sessionScores.some((score) => score.points > 0)
      || (preparationPoints ?? 0) > 0
      || (castleBattlePoints ?? 0) > 0;
    const attendance = positiveScore ? "present" : attendanceOf(member.attended);
    const answerLabel = member.answer === "yes"
      ? (sessionLabels.get(member.sessionId ?? "") ?? "Signed up")
      : member.answer === "no"
        ? "Not attending"
        : member.answer === "maybe"
          ? "Maybe"
          : "No answer";
    const lineupLabel = member.lineup
      ? `${sessionLabels.get(member.lineup.sessionId) ?? member.lineup.sessionId} · ${member.lineup.role === "starter" ? "Starter" : "Sub"} #${member.lineup.position}`
      : null;
    return {
      member,
      attendance,
      attendanceEvidence: positiveScore ? "score" : attendance === "unrecorded" ? null : "record",
      answerLabel,
      lineupLabel,
      sessionScores,
      preparationPoints,
      castleBattlePoints,
      hasEventRecord: member.answer !== null
        || member.lineup !== null
        || attendance !== "unrecorded"
        || sessionScores.length > 0
        || preparationPoints !== null
        || castleBattlePoints !== null,
    };
  });

  const attendanceOrder: Record<CompletedAttendance, number> = { present: 0, absent: 1, excused: 2, unrecorded: 3 };
  return rows.toSorted((a, b) =>
    attendanceOrder[a.attendance] - attendanceOrder[b.attendance]
    || Number(b.hasEventRecord) - Number(a.hasEventRecord)
    || b.sessionScores.reduce((sum, score) => sum + score.points, 0) - a.sessionScores.reduce((sum, score) => sum + score.points, 0)
    || a.member.name.localeCompare(b.member.name),
  );
}

export function completedAttendanceLabel(status: CompletedAttendance): string {
  if (status === "present") return "Attended";
  if (status === "absent") return "Did not attend";
  if (status === "excused") return "Excused";
  return "Not reviewed";
}
