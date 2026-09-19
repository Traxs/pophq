// Single-table key layout. See the spec's "Data model & change history" section.

export const accountKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "PROFILE" });

/** Lock item: at most one login may be linked to a game account. */
export const accountLinkLockKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "LINKED_LOGIN" });

export const loginLinkKey = (sub: string, playerId: string) => ({ PK: `LOGIN#${sub}`, SK: `ACCOUNT#${playerId}` });

/** Report SK sorts by creation (ULID); ordering by effective date happens in the domain. */
export const reportKey = (playerId: string, reportId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `REPORT#${reportId}`,
});

export const eventKey = (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: "META" });

/** Events of an alliance, sorted by start time (GSI1). */
export const eventIndexKey = (alliance: string, startsAt: string, eventId: string) => ({
  GSI1PK: `EVENTS#${alliance}`,
  GSI1SK: `${startsAt}#${eventId}`,
});

/** One answer per game account per event; also readable per account through GSI1. */
export const answerKey = (eventId: string, playerId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `ANSWER#${playerId}`,
});
export const answerIndexKey = (playerId: string, startsAt: string, eventId: string) => ({
  GSI1PK: `ACCOUNT#${playerId}`,
  GSI1SK: `ANSWER#${startsAt}#${eventId}`,
});

/** One item per login that holds a seat, plus a counter so the cap is enforced atomically (FM-08). */
export const seatKey = (sub: string) => ({ PK: `LOGIN#${sub}`, SK: "SEAT" });
export const seatCounterKey = () => ({ PK: "SEATS", SK: "COUNT" });

export const allianceIndexKey = (alliance: string, searchKey: string, playerId: string) => ({
  GSI1PK: `ALLIANCE#${alliance}`,
  GSI1SK: `${searchKey}#${playerId}`,
});
