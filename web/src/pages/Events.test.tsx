import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventMember } from "../api";
import { EventResponseStatus } from "../components/EventResponseStatus";

const member = (registrationRole?: "substitute"): EventMember => ({
  playerId: "399200126",
  name: "xXsarahXx",
  rank: "R3",
  answer: "yes",
  sessionId: "L2",
  answeredAt: "2026-09-30T12:00:00.000Z",
  ...(registrationRole ? { registrationRole } : {}),
  attended: null,
  lineup: null,
  strengthTrend: [],
  attendanceTrend: [],
  power: null,
  foundryStrength: 4652,
  furnace: null,
  troops: {
    infantry: { level: null, helios: null },
    lancer: { level: null, helios: null },
    marksman: { level: null, helios: null },
  },
  troopReportAt: null,
  lastReportAt: null,
});

const sessions = [{ id: "L2", label: "Legion 2", startsAt: "2026-10-03T19:00:00.000Z", signedUp: 1, spotsLeft: null, signedUpList: [], lineup: null, strategy: null, result: null }];

describe("event response status", () => {
  it("shows an explicit substitute badge next to the selected legion", () => {
    const html = renderToStaticMarkup(<EventResponseStatus member={member("substitute")} sessions={sessions} />);
    expect(html).toContain("Legion 2");
    expect(html).toContain(">Sub<");
    expect(html).toContain('aria-label="Legion 2, registered as substitute"');
  });

  it("does not label an ordinary registration as a substitute", () => {
    const html = renderToStaticMarkup(<EventResponseStatus member={member()} sessions={sessions} />);
    expect(html).not.toContain(">Sub<");
  });
});
