import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/dev/demo.js";
import { Repository } from "../../src/data/repository.js";
import type { LoginDirectory } from "../../src/ops/invite.js";
import { createHarness, type Harness } from "./harness.js";

describe("reversible person membership", () => {
  let h: Harness;
  const disabled: string[] = [];
  const enabled: string[] = [];
  const logins: LoginDirectory = {
    findSub: async () => undefined,
    createLogin: async () => "unused",
    createPasswordLogin: async () => ({ sub: "unused", username: "unused", password: "unused" }),
    resetPassword: async () => ({ password: "unused" }),
    disableLogin: async (sub) => { disabled.push(sub); },
    enableLogin: async (sub) => { enabled.push(sub); },
    deleteLogin: async () => undefined,
  };

  beforeAll(async () => {
    h = await createHarness({ logins });
    await seedDemo(h.repo, new Date("2026-09-27T12:00:00Z"));
  });
  afterAll(() => h.cleanup());

  it("marks the main and every secondary account as left and suspends their shared login", async () => {
    const result = await h.call("PUT", "/accounts/100000001/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: false, justification: "Confirmed departure from POP" },
    });

    expect(result.status).toBe(200);
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", status: "transferred_out" }),
      expect.objectContaining({ playerId: "100000002", status: "transferred_out" }),
    ]));
    expect(disabled).toEqual(["player"]);
    expect((result.body.audit as unknown[])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "membership_left",
        justification: "Confirmed departure from POP",
        affectedPlayerIds: ["100000001", "100000002"],
      }),
    ]));
    expect((await h.call("GET", "/me", { as: "player" })).status).toBe(403);
    const participation = await h.call("GET", "/metrics/event-participation?kind=foundry", { as: "officer", groups: ["officer"] });
    expect((participation.body.members as { playerId: string }[]).map((member) => member.playerId)).not.toEqual(
      expect.arrayContaining(["100000001", "100000002"]),
    );
  });

  it("welcomes the person and all linked accounts back without losing history", async () => {
    const result = await h.call("PUT", "/accounts/100000002/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: true, justification: "Return confirmed by alliance leadership" },
    });

    expect(result.status).toBe(200);
    expect(result.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "100000001", status: "active" }),
      expect.objectContaining({ playerId: "100000002", status: "active" }),
    ]));
    expect(enabled).toEqual(["player"]);
    expect((await h.call("GET", "/me", { as: "player" })).status).toBe(200);
    expect((await h.repo.listReports("100000001")).length).toBeGreaterThan(0);
  });

  it("requires R4/R5 access and a permanent reason", async () => {
    expect((await h.call("PUT", "/accounts/100000001/membership", {
      as: "player",
      body: { active: false, justification: "Leaving again" },
    })).status).toBe(403);
    expect((await h.call("PUT", "/accounts/100000001/membership", {
      as: "officer",
      groups: ["officer"],
      body: { active: false, justification: "no" },
    })).status).toBe(400);
  });

  it("does not turn events during a departure into missed participation after a return", async () => {
    const playerId = "700009001";
    const at = (iso: string) => new Repository(h.db, h.tableName, () => new Date(iso));
    await at("2026-07-01T12:00:00.000Z").createAccount(
      { playerId, name: "Returning Member", alliance: "POP", status: "active" },
      { id: "seed", via: "seed" },
    );
    await at("2026-08-01T12:00:00.000Z").setPersonMembership(
      playerId, [playerId], false, "Moved to another alliance", { id: "officer", via: "web" }, "Officer",
    );
    await at("2026-09-01T12:00:00.000Z").setPersonMembership(
      playerId, [playerId], true, "Returned to POP alliance", { id: "officer", via: "web" }, "Officer",
    );
    for (const [eventId, startsAt] of [
      ["MEMBER-BEFORE", "2026-07-20T12:00:00.000Z"],
      ["MEMBER-GAP", "2026-08-10T12:00:00.000Z"],
      ["MEMBER-AFTER", "2026-09-10T12:00:00.000Z"],
    ] as const) {
      await h.repo.createEvent({
        eventId,
        alliance: "POP",
        kind: "other",
        title: eventId,
        startsAt,
        deadlineAt: startsAt,
        sessions: [],
        createdBy: "officer",
      }, { id: "officer", via: "web" });
    }

    const result = await h.call("GET", `/accounts/${playerId}/reliability`, { as: "officer", groups: ["officer"] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ unregistered: 0, sample: 0 });
    expect(result.body.rate).toBeUndefined();
    expect((result.body.events as { eventId: string }[]).map((event) => event.eventId)).toEqual(["MEMBER-AFTER", "MEMBER-BEFORE"]);
  });

  it("records and corrects a legacy former member's effective departure date", async () => {
    const playerId = "700009002";
    await h.repo.createAccount(
      { playerId, name: "Former Member", alliance: "POP", status: "transferred_out" },
      { id: "seed", via: "seed" },
    );

    const recorded = await h.call("PUT", `/accounts/${playerId}/membership/effective-date`, {
      as: "officer",
      groups: ["officer"],
      body: { effectiveDate: "2026-08-10", justification: "Confirmed from the alliance roster" },
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "membership_left", effectiveAt: "2026-08-10T00:00:00.000Z" }),
    ]));

    const corrected = await h.call("PUT", `/accounts/${playerId}/membership/effective-date`, {
      as: "officer",
      groups: ["officer"],
      body: { effectiveDate: "2026-08-01", justification: "Corrected against the departure screenshot" },
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "membership_date_corrected",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        previousEffectiveAt: "2026-08-10T00:00:00.000Z",
      }),
    ]));

    const roster = await h.call("GET", "/roster", { as: "officer", groups: ["officer"] });
    expect((roster.body.items as { playerId: string; membershipLeftAt: string | null }[]).find((item) => item.playerId === playerId)).toMatchObject({
      membershipLeftAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("uses a supplied departure date to exclude later events from attendance", async () => {
    const playerId = "700009003";
    await new Repository(h.db, h.tableName, () => new Date("2026-07-01T12:00:00.000Z")).createAccount(
      { playerId, name: "Historical Departure", alliance: "POP", status: "active" },
      { id: "seed", via: "seed" },
    );
    expect((await h.call("PUT", `/accounts/${playerId}/membership`, {
      as: "officer",
      groups: ["officer"],
      body: { active: false, effectiveDate: "2026-08-01", justification: "Departure date confirmed by officers" },
    })).status).toBe(200);

    for (const [eventId, startsAt] of [
      ["EFFECTIVE-BEFORE", "2026-07-20T12:00:00.000Z"],
      ["EFFECTIVE-AFTER", "2026-08-10T12:00:00.000Z"],
    ] as const) {
      await h.repo.createEvent({
        eventId,
        alliance: "POP",
        kind: "other",
        title: eventId,
        startsAt,
        deadlineAt: startsAt,
        sessions: [],
        createdBy: "officer",
      }, { id: "officer", via: "web" });
    }
    const result = await h.call("GET", `/accounts/${playerId}/reliability`, { as: "officer", groups: ["officer"] });
    const eventIds = (result.body.events as { eventId: string }[]).map((event) => event.eventId);
    expect(eventIds).toContain("EFFECTIVE-BEFORE");
    expect(eventIds).not.toContain("EFFECTIVE-AFTER");
  });
});
