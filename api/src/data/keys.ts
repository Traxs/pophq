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

/** One item per login that holds a seat, plus a counter so the cap is enforced atomically (FM-08). */
export const seatKey = (sub: string) => ({ PK: `LOGIN#${sub}`, SK: "SEAT" });
export const seatCounterKey = () => ({ PK: "SEATS", SK: "COUNT" });

export const allianceIndexKey = (alliance: string, searchKey: string, playerId: string) => ({
  GSI1PK: `ALLIANCE#${alliance}`,
  GSI1SK: `${searchKey}#${playerId}`,
});
