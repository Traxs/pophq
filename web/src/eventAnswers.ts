import type { Answer, EventDetail } from "./api";

export interface SavedEventAnswer {
  answer: Answer;
  sessionId?: string;
  answeredAt: string;
}

/** Keep an already-open officer breakdown in sync after this browser saves an answer. */
export function withEventAnswer(detail: EventDetail, playerId: string, saved: SavedEventAnswer): EventDetail {
  const members = detail.members?.map((member) =>
    member.playerId === playerId
      ? {
          ...member,
          answer: saved.answer,
          sessionId: saved.answer === "yes" ? (saved.sessionId ?? null) : null,
          answeredAt: saved.answeredAt,
        }
      : member,
  );
  if (!members?.some((member) => member.playerId === playerId)) {
    return { ...detail, myAnswer: saved.answer, mySessionId: saved.sessionId ?? null };
  }

  const bySession = Object.fromEntries(
    detail.sessions.map((session) => [
      session.id,
      members.filter((member) => member.answer === "yes" && member.sessionId === session.id).length,
    ]),
  );
  return {
    ...detail,
    myAnswer: saved.answer,
    mySessionId: saved.sessionId ?? null,
    members,
    counts: {
      yes: members.filter((member) => member.answer === "yes").length,
      no: members.filter((member) => member.answer === "no").length,
      maybe: members.filter((member) => member.answer === "maybe").length,
      pending: members.filter((member) => member.answer === null).length,
      bySession,
    },
  };
}
