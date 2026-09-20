import { Fragment, type ReactNode } from "react";
import type { SessionView, StrategyRole } from "./api";

/**
 * Deliberately tiny strategy formatting: paragraphs separated by blank lines, `- ` bullets and
 * paired **bold** markers. Everything remains React text, so HTML and unsupported Markdown are
 * displayed literally rather than interpreted.
 */
export function renderStrategyText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const value = paragraph.join(" ");
    nodes.push(<p key={`p-${key++}`}>{inlineBold(value, `p-${key}`)}</p>);
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    nodes.push(
      <ul key={`ul-${key++}`}>
        {bullets.map((value, index) => (
          <li key={index}>{inlineBold(value, `li-${key}-${index}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      flushParagraph();
      flushBullets();
    } else if (line.startsWith("- ")) {
      flushParagraph();
      bullets.push(line.slice(2));
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();
  return nodes;
}

function inlineBold(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let start = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > start) nodes.push(text.slice(start, match.index));
    nodes.push(<strong key={`${keyPrefix}-${index++}`}>{match[1]}</strong>);
    start = match.index + match[0].length;
  }
  if (start < text.length) nodes.push(text.slice(start));
  return nodes;
}

export interface StrategyDraftAssignment {
  playerId: string;
  name: string;
  role: StrategyRole | "";
  duty: string;
  note: string;
}

/** Starts from the published assignments, then includes every selected player not yet assigned. */
export function strategyDraftFor(session: SessionView): StrategyDraftAssignment[] {
  const published = session.strategy?.assignments.map((assignment) => ({
    playerId: assignment.playerId,
    name: assignment.name,
    role: assignment.role,
    duty: assignment.duty ?? "",
    note: assignment.note ?? "",
  })) ?? [];
  const seen = new Set(published.map((assignment) => assignment.playerId));
  for (const entry of session.lineup?.entries ?? []) {
    if (seen.has(entry.playerId)) continue;
    published.push({
      playerId: entry.playerId,
      name: entry.name,
      role: entry.role === "sub" ? "Substitute Looter" : "Holder",
      duty: "",
      note: "",
    });
  }
  return published;
}

export function assignmentsToPublish(rows: readonly StrategyDraftAssignment[]) {
  return rows
    .filter((row): row is StrategyDraftAssignment & { role: StrategyRole } => row.role !== "")
    .map(({ playerId, role, duty, note }) => ({
      playerId,
      role,
      ...(duty.trim() ? { duty: duty.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }));
}

/** React fragments are useful when this helper is consumed outside a wrapping element. */
export function StrategyText({ text }: { text: string }) {
  return <Fragment>{renderStrategyText(text)}</Fragment>;
}
