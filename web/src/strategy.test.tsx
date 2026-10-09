import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionView } from "./api";
import { assignmentsToPublish, renderStrategyText, strategyDraftFor } from "./strategy";

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "L1",
  label: "Legion 1",
  startsAt: "2026-09-27T12:00:00Z",
  starters: 2,
  subs: 1,
  signedUp: 0,
  spotsLeft: 3,
  signedUpList: [],
  lineup: {
    version: 1,
    publishedAt: "2026-09-20T12:00:00Z",
    entries: [
      { playerId: "700000001", name: "Northstar", role: "starter", position: 1, foundryStrength: 90, signedUp: true },
      { playerId: "700000002", name: "Snowguard", role: "sub", position: 1, foundryStrength: 80, signedUp: true },
    ],
  },
  strategy: null,
  ...over,
});

describe("renderStrategyText", () => {
  it("renders only paragraphs, bullets and bold text", () => {
    const html = renderToStaticMarkup(<div>{renderStrategyText("**Opening** now\n\n- Hold left\n- Rally **together**")}</div>);
    expect(html).toBe("<div><p><strong>Opening</strong> now</p><ul><li>Hold left</li><li>Rally <strong>together</strong></li></ul></div>");
  });

  it("escapes HTML and leaves unsupported Markdown literal", () => {
    const html = renderToStaticMarkup(<div>{renderStrategyText("## Plan <img src=x onerror=alert(1)>")}</div>);
    expect(html).toContain("## Plan &lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });
});

describe("strategy drafts", () => {
  it("starts selected players with useful role defaults", () => {
    expect(strategyDraftFor(session()).map((row) => `${row.name}:${row.role}`)).toEqual([
      "Northstar:Holder",
      "Snowguard:Substitute Looter",
    ]);
  });

  it("keeps published work and adds a newly selected player", () => {
    const rows = strategyDraftFor(
      session({
        strategy: {
          version: 2,
          body: "Plan",
          publishedAt: "2026-09-21T12:00:00Z",
          assignments: [{ playerId: "700000001", name: "Northstar", role: "Farmer", duty: "Workshop" }],
        },
      }),
    );
    expect(rows.map((row) => ({ name: row.name, role: row.role, duty: row.duty }))).toEqual([
      { name: "Northstar", role: "Farmer", duty: "Workshop" },
      { name: "Snowguard", role: "Substitute Looter", duty: "" },
    ]);
  });

  it("trims optional fields before publishing", () => {
    expect(
      assignmentsToPublish([
        { playerId: "700000001", name: "Northstar", role: "Holder", rallyLeadPlayerId: "", duty: " Gate ", note: " Lead " },
        { playerId: "700000002", name: "Snowguard", role: "", rallyLeadPlayerId: "", duty: "", note: "" },
      ]),
    ).toEqual([{ playerId: "700000001", role: "Holder", duty: "Gate", note: "Lead" }]);
  });

  it("builds an SvS rally draft from signups before a lineup exists", () => {
    const noLineup = session({
      lineup: null,
      signedUp: 2,
      signedUpList: [
        { playerId: "700000001", name: "Northstar", foundryStrength: 90, position: 1, likely: "starter" },
        { playerId: "700000002", name: "Snowguard", foundryStrength: 80, position: 2, likely: "sub" },
      ],
    });
    expect(strategyDraftFor(noLineup, true).map((row) => ({ name: row.name, role: row.role }))).toEqual([
      { name: "Northstar", role: "" },
      { name: "Snowguard", role: "" },
    ]);
    expect(assignmentsToPublish([
      { playerId: "700000001", name: "Northstar", role: "Rally Lead", rallyLeadPlayerId: "", duty: "", note: "" },
      { playerId: "700000002", name: "Snowguard", role: "Rally Member", rallyLeadPlayerId: "700000001", duty: "", note: "" },
    ])).toEqual([
      { playerId: "700000001", role: "Rally Lead" },
      { playerId: "700000002", role: "Rally Member", rallyLeadPlayerId: "700000001" },
    ]);
  });
});
