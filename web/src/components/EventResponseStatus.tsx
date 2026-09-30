import type { EventDetail, EventMember } from "../api";

/** A substitute is an explicit signup choice, so keep it visible next to the selected legion. */
export function EventResponseStatus({ member, sessions }: { member: EventMember; sessions: EventDetail["sessions"] }) {
  const label = member.answer === "yes"
    ? (sessions.find((session) => session.id === member.sessionId)?.label ?? "Joined")
    : member.answer === "no"
      ? "Can't"
      : member.answer === "maybe"
        ? "Maybe"
        : "No answer";
  const substitute = member.answer === "yes" && member.registrationRole === "substitute";
  return <span className="response-registration" aria-label={substitute ? `${label}, registered as substitute` : label}>
    <span className={`response-status response-status-${member.answer ?? "pending"}`}>{label}</span>
    {substitute && <span className="response-role-sub">Sub</span>}
  </span>;
}
