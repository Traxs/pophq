import { describe, expect, it } from "vitest";
import type { RosterRow } from "../api";
import { inviteSuggestions } from "../inviteCandidates";

const row = (name: string, playerId: string, hasLogin: boolean): RosterRow => ({
  playerId,
  name,
  alliance: "POP",
  status: "active",
  hasLogin,
  power: null,
  previousPower: null,
  lastReportAt: null,
  foundryStrength: null,
  lastFoundryReportAt: null,
  furnace: null,
  powerTrend: [],
  strengthTrend: [],
  attendanceTrend: [],
  attendance: { attended: 0, noShows: 0, unregistered: 0, excused: 0, sample: 0, events: [] },
  reports: 0,
});

describe("inviteSuggestions", () => {
  const roster = [
    row("Arya Stark", "405338501", false),
    row("Arctic Fox", "401111111", true),
    row("Dream", "401297791", false),
  ];

  it("finds unregistered members by name", () => {
    expect(inviteSuggestions(roster, "arya").map((candidate) => candidate.playerId)).toEqual(["405338501"]);
  });

  it("finds unregistered members by Player ID and excludes registered people", () => {
    expect(inviteSuggestions(roster, "401").map((candidate) => candidate.name)).toEqual(["Dream"]);
  });
});
