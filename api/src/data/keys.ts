// Single-table key layout. See the spec's "Data model & change history" section.

export const accountKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "PROFILE" });

/** Lock item: at most one login may be linked to a game account. */
export const accountLinkLockKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "LINKED_LOGIN" });

/** Officer-visible security log. Records are never deleted; stream history preserves updates. */
export const accessAuditKey = (playerId: string, auditId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `ACCESS_AUDIT#${auditId}`,
});

export const loginLinkKey = (sub: string, playerId: string) => ({ PK: `LOGIN#${sub}`, SK: `ACCOUNT#${playerId}` });

/** Report SK sorts by creation (ULID); ordering by effective date happens in the domain. */
export const reportKey = (playerId: string, reportId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `REPORT#${reportId}`,
});

/** Event types are alliance-wide, so they share one partition and list in a single query. */
export const eventTypeKey = (typeId: string) => ({ PK: "EVENTTYPES", SK: `TYPE#${typeId}` });

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

/** Attendance: one record per game account per event, readable per event and per account. */
export const attendanceKey = (eventId: string, playerId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `ATTEND#${playerId}`,
});
export const attendanceIndexKey = (playerId: string, recordedAt: string, eventId: string) => ({
  GSI1PK: `ACCOUNT#${playerId}`,
  GSI1SK: `ATTEND#${recordedAt}#${eventId}`,
});

/** One item per login that holds a seat, plus a counter so the cap is enforced atomically (FM-08). */
export const seatKey = (sub: string) => ({ PK: `LOGIN#${sub}`, SK: "SEAT" });
export const seatCounterKey = () => ({ PK: "SEATS", SK: "COUNT" });

export const allianceIndexKey = (alliance: string, searchKey: string, playerId: string) => ({
  GSI1PK: `ALLIANCE#${alliance}`,
  GSI1SK: `${searchKey}#${playerId}`,
});

/** The published lineup for one part of an event (P5.4); replaced, and versioned, on publish. */
export const lineupKey = (eventId: string, sessionId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `LINEUP#${sessionId}`,
});

/** The published strategy for one part of an event (P5.5); replaced and versioned on publish. */
export const strategyKey = (eventId: string, sessionId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `STRATEGY#${sessionId}`,
});

/** Officer-recorded outcome for one event part (P5.6b); replaced and versioned on correction. */
export const resultKey = (eventId: string, sessionId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `RESULT#${sessionId}`,
});

export const agentTokenKey = (tokenId: string) => ({ PK: `TOKEN#${tokenId}`, SK: "META" });
export const idempotencyKey = (tokenId: string, key: string) => ({ PK: `TOKEN#${tokenId}`, SK: `IDEMPOTENCY#${key}` });

/** Immutable imported facts whose product-specific model does not exist yet. */
export const historicalRecordKey = (category: string, recordId: string) => ({
  PK: `HISTORYIMPORT#${category}`,
  SK: `RECORD#${recordId}`,
});

/** An SvS round and everything that belongs to it (BUF-01..BUF-06). */
export const svsRoundKey = (roundId: string) => ({ PK: `SVS#${roundId}`, SK: "META" });

/** Rounds of an alliance, earliest buff day first (GSI1). */
export const svsRoundIndexKey = (alliance: string, firstDate: string, roundId: string) => ({
  GSI1PK: `SVSROUNDS#${alliance}`,
  GSI1SK: `${firstDate}#${roundId}`,
});

/** One set of preferences per game account per round. */
export const svsPreferencesKey = (roundId: string, playerId: string) => ({
  PK: `SVS#${roundId}`,
  SK: `PREF#${playerId}`,
});

/** Kudos are immutable awards on an account, newest last by ULID. */
export const kudosKey = (playerId: string, awardId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `KUDOS#${awardId}`,
});

/** One distributable Fortress reward batch and its immutable recipient records. */
export const fortressBuffPoolKey = (poolId: string) => ({ PK: `FORTBUFF#${poolId}`, SK: "META" });
export const fortressBuffPoolIndexKey = (alliance: string, acquiredAt: string, poolId: string) => ({
  GSI1PK: `FORTBUFFS#${alliance}`,
  GSI1SK: `${acquiredAt}#${poolId}`,
});
export const fortressBuffAssignmentKey = (poolId: string, playerId: string) => ({
  PK: `FORTBUFF#${poolId}`,
  SK: `ASSIGN#${playerId}`,
});

/** The checklist of jobs for running one event; one item, replaced as officers tick things off. */
export const checklistKey = (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: "CHECKLIST" });
