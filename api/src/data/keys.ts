// Single-table key layout. See the spec's "Data model & change history" section.

export const accountKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "PROFILE" });

/** Lock item: at most one login may be linked to a game account. */
export const accountLinkLockKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "LINKED_LOGIN" });

/** Officer-visible security log. Records are never deleted; stream history preserves updates. */
export const accessAuditKey = (playerId: string, auditId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `ACCESS_AUDIT#${auditId}`,
});

/** Public onboarding looks up only a SHA-256 digest; the bearer token itself is never stored. */
export const onboardingInviteTokenKey = (tokenHash: string) => ({ PK: `ONBOARDING#${tokenHash}`, SK: "META" });

/** Permanent officer-visible lifecycle audit, retained after the short-lived token mapping expires. */
export const onboardingInviteAuditKey = (playerId: string, inviteId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `ONBOARDING_INVITE#${inviteId}`,
});

export const loginLinkKey = (sub: string, playerId: string) => ({ PK: `LOGIN#${sub}`, SK: `ACCOUNT#${playerId}` });

/** Which linked account represents a person in people-level views. */
export const personIdentityKey = (sub: string) => ({ PK: `LOGIN#${sub}`, SK: "IDENTITY" });

/** Account relationships exist independently of authentication. The same compact group is
 * copied onto every member so any Player ID can resolve the person with one strongly-consistent read. */
export const accountIdentityGroupKey = (playerId: string) => ({ PK: `ACCOUNT#${playerId}`, SK: "IDENTITY_GROUP" });

/** Previous/alternate names remain attached to the exact Player ID. */
export const accountAliasKey = (playerId: string, normalizedName: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `ALIAS#${encodeURIComponent(normalizedName)}`,
});

/** Race-safe ownership claim for a canonical or alternate name inside one alliance. */
export const accountNameClaimKey = (alliance: string, normalizedName: string) => ({
  PK: `ACCOUNTNAME#${alliance}`,
  SK: `NAME#${encodeURIComponent(normalizedName)}`,
});

/** Immutable officer log for account relationship and alias changes. */
export const identityAuditKey = (playerId: string, auditId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `IDENTITY_AUDIT#${auditId}`,
});

/** Report SK sorts by creation (ULID); ordering by effective date happens in the domain. */
export const reportKey = (playerId: string, reportId: string) => ({
  PK: `ACCOUNT#${playerId}`,
  SK: `REPORT#${reportId}`,
});

/** Event types are alliance-wide, so they share one partition and list in a single query. */
export const eventTypeKey = (typeId: string) => ({ PK: "EVENTTYPES", SK: `TYPE#${typeId}` });

export const eventKey = (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: "META" });

/** One Preparation/Battle score per game account for SvS and King of Icefield. */
export const eventScoreKey = (eventId: string, phase: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `PHASE_SCORE#${phase}`,
});

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

/** One claimed Ministry slot. Slot and claimant locks make double-booking impossible. */
export const ministryBookingKey = (roundId: string, dayId: string, slot: number) => ({
  PK: `SVS#${roundId}`,
  SK: `BOOKING#${dayId}#${String(slot).padStart(2, "0")}`,
});
export const ministryBookerKey = (roundId: string, dayId: string, bookerKey: string) => ({
  PK: `SVS#${roundId}`,
  SK: `BOOKER#${dayId}#${bookerKey}`,
});

/** Guest management links resolve through a digest; the bearer secret is never stored. */
export const ministryGuestTokenKey = (tokenHash: string) => ({
  PK: `MINISTRY_GUEST#${tokenHash}`,
  SK: "META",
});
export const ministryBookingAuditKey = (roundId: string, auditId: string) => ({
  PK: `SVS#${roundId}`,
  SK: `BOOKING_AUDIT#${auditId}`,
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
