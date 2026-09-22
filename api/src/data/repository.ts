import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { GameAccount } from "../domain/accounts.js";
import type { AccessAuditRecord, LoginMethod, PasswordResetStatus } from "../domain/access.js";
import type { AttendanceRecord } from "../domain/attendance.js";
import type { AllianceEvent, Answer, EventAnswer } from "../domain/events.js";
import type { EventType } from "../domain/eventTypes.js";
import type { KudosAward } from "../domain/kudos.js";
import { DEFAULT_REWARD_VALUATIONS, type FortressBuffAssignment, type FortressBuffPool } from "../domain/fortressBuffs.js";
import type { Checklist } from "../domain/checklists.js";
import type { Lineup } from "../domain/lineups.js";
import type { SlotPreferences, SvsRound } from "../domain/svs.js";
import type { Strategy } from "../domain/strategy.js";
import type { EventResult } from "../domain/results.js";
import type { AgentTokenRecord } from "../domain/agentTokens.js";
import type { HistoricalCategory, HistoricalRecord } from "../domain/historicalRecords.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { searchKey } from "../domain/identity.js";
import type { Report } from "../domain/measurements.js";
import { SEAT_CAP, type Seats } from "../domain/seats.js";
import {
  accountKey,
  accessAuditKey,
  agentTokenKey,
  checklistKey,
  answerIndexKey,
  answerKey,
  attendanceIndexKey,
  attendanceKey,
  accountLinkLockKey,
  allianceIndexKey,
  eventIndexKey,
  eventKey,
  eventTypeKey,
  fortressBuffAssignmentKey,
  fortressBuffPoolIndexKey,
  fortressBuffPoolKey,
  kudosKey,
  lineupKey,
  idempotencyKey,
  historicalRecordKey,
  loginLinkKey,
  reportKey,
  resultKey,
  seatCounterKey,
  seatKey,
  strategyKey,
  svsPreferencesKey,
  svsRoundIndexKey,
  svsRoundKey,
} from "./keys.js";
import { newItemMeta, type Actor } from "./meta.js";

/**
 * Accounts that may receive new data (FM-12): members, guests, and accounts whose membership
 * we don't know yet (imported history). Accounts that transferred out or were archived may not.
 */
const WRITABLE_STATUSES = { ":active": "active", ":guest": "guest", ":unknown": "unknown" };

export class Repository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createAccount(account: GameAccount, actor: Actor): Promise<void> {
    const now = this.clock();
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...accountKey(account.playerId),
            ...allianceIndexKey(account.alliance, searchKey(account.name), account.playerId),
            type: "account",
            ...account,
            ...newItemMeta(actor, now),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`Player ID ${account.playerId} already exists.`);
      }
      throw err;
    }
  }

  /**
   * Replaces an account's details. The roster index is keyed on the name, so a rename rewrites
   * it here — otherwise the account would still exist but drop out of the Members list.
   */
  async updateAccount(account: GameAccount, actor: Actor): Promise<void> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...accountKey(account.playerId),
            ...allianceIndexKey(account.alliance, searchKey(account.name), account.playerId),
            type: "account",
            ...account,
            ...newItemMeta(actor, this.clock()),
          },
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new NotFoundError(`Game account ${account.playerId} not found.`);
      }
      throw err;
    }
  }

  async getAccount(playerId: string): Promise<GameAccount | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: accountKey(playerId) }));
    return res.Item ? toAccount(res.Item) : undefined;
  }

  async listAccounts(alliance: string): Promise<GameAccount[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `ALLIANCE#${alliance}` },
    });
    return items.map(toAccount);
  }

  /**
   * Links a game account to a login. One transaction: the account must exist, and the lock item
   * guarantees a Player ID is never linked to two logins, even under concurrent requests.
   */
  async linkAccount(sub: string, playerId: string, actor: Actor, loginMethod?: LoginMethod): Promise<void> {
    const now = this.clock();
    const meta = newItemMeta(actor, now);
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(playerId),
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...accountLinkLockKey(playerId), type: "link-lock", sub, ...(loginMethod ? { loginMethod } : {}), ...meta },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...loginLinkKey(sub, playerId),
                  GSI1PK: `ACCOUNT#${playerId}`,
                  GSI1SK: `LOGIN#${sub}`,
                  type: "login-link",
                  sub,
                  playerId,
                  ...meta,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") throw new NotFoundError(`Game account ${playerId} not found.`);
      if (reasons?.[1] === "ConditionalCheckFailed") {
        throw new ConflictError(`Game account ${playerId} is already linked to a login.`);
      }
      throw err;
    }
  }

  // ---- Attendance (EVT-07) ----

  /** Records who turned up. One record per account per event; a later record replaces an earlier one. */
  async setAttendance(
    record: Omit<AttendanceRecord, "recordedAt">,
    actor: Actor,
    recordedAt = this.clock().toISOString(),
  ): Promise<AttendanceRecord> {
    const full: AttendanceRecord = { ...record, recordedAt };
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...attendanceKey(record.eventId, record.playerId),
          ...attendanceIndexKey(record.playerId, recordedAt, record.eventId),
          type: "attendance",
          ...full,
          ...newItemMeta(actor, this.clock()),
        },
      }),
    );
    return full;
  }

  async listAttendance(eventId: string): Promise<AttendanceRecord[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "ATTEND#" },
    });
    return items.map(toAttendance);
  }

  async getAttendance(eventId: string, playerId: string): Promise<AttendanceRecord | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: attendanceKey(eventId, playerId) }));
    return res.Item ? toAttendance(res.Item) : undefined;
  }

  /** One account's attendance across events, newest first. */
  async attendanceFor(playerId: string, limit = 50): Promise<AttendanceRecord[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":sk": "ATTEND#" },
      ScanIndexForward: false,
      Limit: limit,
    });
    return items.map(toAttendance);
  }

  // ---- Event types (EVT-01) ----

  /** Creates or replaces a type. Officers own these; events inherit from them. */
  async putEventType(type: EventType, actor: Actor): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...eventTypeKey(type.typeId), type: "event-type", ...type, ...newItemMeta(actor, this.clock()) },
      }),
    );
  }

  async getEventType(typeId: string): Promise<EventType | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: eventTypeKey(typeId) }));
    return res.Item ? toEventType(res.Item) : undefined;
  }

  async listEventTypes(): Promise<EventType[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": "EVENTTYPES", ":sk": "TYPE#" },
    });
    return items.map(toEventType);
  }

  // ---- Events (EVT-01..EVT-03) ----

  async createEvent(event: AllianceEvent, actor: Actor): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...eventKey(event.eventId),
            ...eventIndexKey(event.alliance, event.startsAt, event.eventId),
            type: "event",
            ...event,
            ...meta,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConflictError("That event already exists.");
      throw err;
    }
  }

  /** Replaces an event's details; the event must exist. Answers are untouched. */
  async updateEvent(event: AllianceEvent, actor: Actor): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...eventKey(event.eventId),
            ...eventIndexKey(event.alliance, event.startsAt, event.eventId),
            type: "event",
            ...event,
            ...meta,
          },
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new NotFoundError("Event not found.");
      throw err;
    }
  }

  /**
   * Gives a legacy single-part event its missing part and assigns every existing yes answer to
   * it atomically. The empty-parts condition prevents two officers from configuring it at once.
   */
  async configureLegacySession(event: AllianceEvent, answers: readonly EventAnswer[], actor: Actor): Promise<number> {
    const yes = answers.filter((answer) => answer.answer === "yes");
    if (yes.some((answer) => answer.sessionId)) {
      throw new ConflictError("This event has inconsistent signups and needs manual repair.");
    }
    // DynamoDB transactions accept at most 100 actions; one is reserved for the event.
    if (yes.length > 99) throw new ConflictError("This event has too many signups to convert safely in one operation.");

    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                ...eventKey(event.eventId),
                ...eventIndexKey(event.alliance, event.startsAt, event.eventId),
                type: "event",
                ...event,
                ...meta,
              },
              ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(sessions) OR size(sessions) = :zero)",
              ExpressionAttributeValues: { ":zero": 0 },
            },
          },
          ...yes.map((answer) => ({
            Update: {
              TableName: this.table,
              Key: answerKey(event.eventId, answer.playerId),
              UpdateExpression:
                "SET sessionId = :sessionId, updatedAt = :updatedAt, updatedBy = :updatedBy, via = :via, changeId = :changeId, reason = :reason, #version = if_not_exists(#version, :zero) + :one",
              ConditionExpression: "attribute_exists(PK) AND answer = :yes AND attribute_not_exists(sessionId)",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: {
                ":sessionId": event.sessions[0]!.id,
                ":updatedAt": meta.updatedAt,
                ":updatedBy": meta.updatedBy,
                ":via": meta.via,
                ":changeId": meta.changeId,
                ":reason": actor.reason ?? "legacy event part configured",
                ":zero": 0,
                ":one": 1,
                ":yes": "yes",
              },
            },
          })),
        ],
      }));
      return yes.length;
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new ConflictError("This event was already configured or changed. Reload and try again.");
      }
      throw err;
    }
  }

  async getEvent(eventId: string): Promise<AllianceEvent | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: eventKey(eventId) }));
    return res.Item ? toEvent(res.Item) : undefined;
  }

  /** Events of an alliance that start at or after `from`, earliest first. */
  async listEvents(alliance: string, from: string, limit = 50): Promise<AllianceEvent[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK >= :from",
      ExpressionAttributeValues: { ":pk": `EVENTS#${alliance}`, ":from": from },
      Limit: limit,
    });
    return items.map(toEvent);
  }

  // ---- Published lineups (P5.4) ----

  /**
   * Publishes a lineup for one part of an event. The write only succeeds against the version the
   * officer edited, so of two officers publishing at the same moment the second one is told to
   * reload instead of quietly replacing the first (FM-10).
   */
  async putLineup(lineup: Lineup, actor: Actor): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...lineupKey(lineup.eventId, lineup.sessionId),
            type: "lineup",
            ...meta,
            // After the meta on purpose: a lineup's own version is the item's version, counting
            // publishes rather than resetting to 1 each time.
            ...lineup,
          },
          ConditionExpression: "attribute_not_exists(SK) OR version = :previous",
          ExpressionAttributeValues: { ":previous": lineup.version - 1 },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError("Someone else published this lineup while you were editing. Reload and try again.");
      }
      throw err;
    }
  }

  async getLineup(eventId: string, sessionId: string): Promise<Lineup | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: lineupKey(eventId, sessionId) }));
    return res.Item ? toLineup(res.Item) : undefined;
  }

  /** Every published lineup of an event, one per part. */
  async listLineups(eventId: string): Promise<Lineup[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "LINEUP#" },
    });
    return items.map(toLineup);
  }

  // ---- Published strategies (P5.5) ----

  /** Publishes against the version the officer edited, exactly like a lineup. */
  async putStrategy(strategy: Strategy, actor: Actor): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...strategyKey(strategy.eventId, strategy.sessionId),
            type: "strategy",
            ...meta,
            ...strategy,
          },
          ConditionExpression: "attribute_not_exists(SK) OR version = :previous",
          ExpressionAttributeValues: { ":previous": strategy.version - 1 },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError("Someone else published this strategy while you were editing. Reload and try again.");
      }
      throw err;
    }
  }

  async getStrategy(eventId: string, sessionId: string): Promise<Strategy | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: strategyKey(eventId, sessionId) }));
    return res.Item ? toStrategy(res.Item) : undefined;
  }

  /** Every published strategy of an event, one per part. */
  async listStrategies(eventId: string): Promise<Strategy[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "STRATEGY#" },
    });
    return items.map(toStrategy);
  }

  // ---- Event results (P5.6b) ----

  async putResult(result: EventResult, actor: Actor): Promise<void> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table,
        Item: { ...resultKey(result.eventId, result.sessionId), type: "event-result", ...newItemMeta(actor, this.clock()), ...result },
        ConditionExpression: "attribute_not_exists(SK) OR version = :previous",
        ExpressionAttributeValues: { ":previous": result.version - 1 },
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError("Someone else saved this result while you were editing. Reload and try again.");
      }
      throw err;
    }
  }

  async getResult(eventId: string, sessionId: string): Promise<EventResult | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: resultKey(eventId, sessionId) }));
    return res.Item ? toResult(res.Item) : undefined;
  }

  async listResults(eventId: string): Promise<EventResult[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "RESULT#" },
    });
    return items.map(toResult);
  }

  async putResultIdempotent(result: EventResult, actor: Actor, tokenId: string, key: string, bodyHash: string): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: {
          TableName: this.table,
          Item: { ...resultKey(result.eventId, result.sessionId), type: "event-result", ...meta, ...result },
          ConditionExpression: "attribute_not_exists(SK) OR version = :previous",
          ExpressionAttributeValues: { ":previous": result.version - 1 },
        } },
        { Put: {
          TableName: this.table,
          Item: {
            ...idempotencyKey(tokenId, key),
            type: "agent-idempotency",
            bodyHash,
            result,
            createdAt: meta.createdAt,
            expiresAtEpoch: Math.floor(this.clock().getTime() / 1000) + 24 * 60 * 60,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        } },
      ] }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new ConflictError("The result changed or this idempotency key was already used. Reload before retrying.");
      }
      throw err;
    }
  }

  async getIdempotentResult(tokenId: string, key: string): Promise<{ bodyHash: string; result: EventResult } | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: idempotencyKey(tokenId, key) }));
    if (!res.Item) return undefined;
    return { bodyHash: String(res.Item.bodyHash), result: res.Item.result as EventResult };
  }

  /** Creates or replaces an event and records the bot retry key in the same transaction. */
  async putEventIdempotent(
    event: AllianceEvent,
    mode: "create" | "update",
    actor: Actor,
    tokenId: string,
    key: string,
    bodyHash: string,
    previous?: AllianceEvent,
  ): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    const updateCondition = previous
      ? {
          ConditionExpression:
            "attribute_exists(PK) AND alliance = :alliance AND #kind = :kind AND title = :title AND startsAt = :startsAt AND deadlineAt = :deadlineAt AND sessions = :sessions AND createdBy = :createdBy" +
            (previous.notes ? " AND notes = :notes" : " AND attribute_not_exists(notes)"),
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: {
            ":alliance": previous.alliance,
            ":kind": previous.kind,
            ":title": previous.title,
            ":startsAt": previous.startsAt,
            ":deadlineAt": previous.deadlineAt,
            ":sessions": previous.sessions,
            ":createdBy": previous.createdBy,
            ...(previous.notes ? { ":notes": previous.notes } : {}),
          },
        }
      : {};
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                ...eventKey(event.eventId),
                ...eventIndexKey(event.alliance, event.startsAt, event.eventId),
                type: "event",
                ...event,
                ...meta,
              },
              ...(mode === "create" ? { ConditionExpression: "attribute_not_exists(PK)" } : updateCondition),
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: {
                ...idempotencyKey(tokenId, key),
                type: "agent-idempotency",
                bodyHash,
                event,
                createdAt: meta.createdAt,
                expiresAtEpoch: Math.floor(this.clock().getTime() / 1000) + 24 * 60 * 60,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new ConflictError("The event changed or this idempotency key was already used. Reload before retrying.");
      }
      throw err;
    }
  }

  async getIdempotentEvent(tokenId: string, key: string): Promise<{ bodyHash: string; event: AllianceEvent } | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: idempotencyKey(tokenId, key) }));
    if (!res.Item?.event) return undefined;
    return { bodyHash: String(res.Item.bodyHash), event: res.Item.event as AllianceEvent };
  }

  /** Retry marker for guarded historical writes whose domain write has its own safety condition. */
  async putIdempotentChange(tokenId: string, key: string, bodyHash: string, response: unknown): Promise<void> {
    const createdAt = this.clock().toISOString();
    try {
      await this.db.send(new PutCommand({
        TableName: this.table,
        Item: {
          ...idempotencyKey(tokenId, key),
          type: "agent-idempotency",
          bodyHash,
          response,
          createdAt,
          expiresAtEpoch: Math.floor(this.clock().getTime() / 1000) + 24 * 60 * 60,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError("This idempotency key was already used. Reload before retrying.");
      }
      throw err;
    }
  }

  async getIdempotentChange(tokenId: string, key: string): Promise<{ bodyHash: string; response: unknown } | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: idempotencyKey(tokenId, key) }));
    if (!res.Item) return undefined;
    return { bodyHash: String(res.Item.bodyHash), response: res.Item.response };
  }

  async createHistoricalRecord(record: HistoricalRecord, actor: Actor): Promise<void> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table,
        Item: {
          ...historicalRecordKey(record.category, record.recordId),
          type: "historical-import",
          ...record,
          ...newItemMeta(actor, this.clock()),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConflictError(`Historical record ${record.recordId} already exists.`);
      throw err;
    }
  }

  async getHistoricalRecord(category: HistoricalCategory, recordId: string): Promise<HistoricalRecord | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: historicalRecordKey(category, recordId) }));
    return res.Item ? toHistoricalRecord(res.Item) : undefined;
  }

  async listHistoricalRecords(category: HistoricalCategory, limit = 500): Promise<HistoricalRecord[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `HISTORYIMPORT#${category}`, ":sk": "RECORD#" },
      Limit: limit,
    });
    return items.map(toHistoricalRecord);
  }

  // ---- Agent tokens (P9.1, narrow result scopes first) ----

  async createAgentToken(record: AgentTokenRecord): Promise<void> {
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...agentTokenKey(record.tokenId), type: "agent-token", ...record },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
  }

  async getAgentToken(tokenId: string): Promise<AgentTokenRecord | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: agentTokenKey(tokenId) }));
    return res.Item ? toAgentToken(res.Item) : undefined;
  }

  async listAgentTokens(issuedBy?: string): Promise<AgentTokenRecord[]> {
    const items = await this.scanAll({
      FilterExpression: "#type = :type" + (issuedBy ? " AND issuedBy = :issuedBy" : ""),
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":type": "agent-token", ...(issuedBy ? { ":issuedBy": issuedBy } : {}) },
    });
    return items.map(toAgentToken);
  }

  async touchAgentToken(tokenId: string, at: Date): Promise<void> {
    await this.db.send(new UpdateCommand({
      TableName: this.table,
      Key: agentTokenKey(tokenId),
      UpdateExpression: "SET lastUsedAt = :at",
      ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(revokedAt)",
      ExpressionAttributeValues: { ":at": at.toISOString() },
    }));
  }

  async revokeAgentToken(tokenId: string, issuedBy: string, at: Date): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table,
        Key: agentTokenKey(tokenId),
        UpdateExpression: "SET revokedAt = :at",
        ConditionExpression: "attribute_exists(PK) AND issuedBy = :issuedBy",
        ExpressionAttributeValues: { ":at": at.toISOString(), ":issuedBy": issuedBy },
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new NotFoundError("Agent token not found.");
      throw err;
    }
  }

  // ---- Event checklists ----

  /**
   * Replaces an event's checklist. The version guards a tick against a colleague's tick landing
   * at the same moment: the loser is told to reload rather than wiping the other's work.
   */
  async putChecklist(checklist: Checklist, actor: Actor): Promise<void> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...checklistKey(checklist.eventId), type: "checklist", ...meta, ...checklist },
          ConditionExpression: "attribute_not_exists(SK) OR version = :previous",
          ExpressionAttributeValues: { ":previous": checklist.version - 1 },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError("Someone else changed this checklist. Reload and try again.");
      }
      throw err;
    }
  }

  async getChecklist(eventId: string): Promise<Checklist | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: checklistKey(eventId) }));
    return res.Item ? toChecklist(res.Item) : undefined;
  }

  async listAnswers(eventId: string): Promise<EventAnswer[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "ANSWER#" },
    });
    return items.map(toAnswer);
  }

  async getAnswer(eventId: string, playerId: string): Promise<EventAnswer | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: answerKey(eventId, playerId) }));
    return res.Item ? toAnswer(res.Item) : undefined;
  }

  /** Answers a game account has given for events starting at or after `from`. */
  async answersForAccount(playerId: string, from: string): Promise<EventAnswer[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":from": `ANSWER#${from}`, ":to": "ANSWER#~" },
    });
    return items.map(toAnswer);
  }

  /**
   * Records an answer. The event must exist, and for members the deadline must still be open at
   * the moment of the write, so a late answer can't slip through between reading and writing
   * (FM-09). Officers keep editing until the event starts: lineups change to the last minute.
   */
  async setAnswer(
    event: Pick<AllianceEvent, "eventId" | "startsAt" | "deadlineAt">,
    playerId: string,
    choice: { answer: Answer; sessionId?: string },
    source: EventAnswer["source"],
    actor: Actor,
    note?: string,
    options: { afterDeadline?: boolean; historic?: boolean; answeredAt?: string } = {},
  ): Promise<EventAnswer> {
    const now = this.clock();
    const meta = newItemMeta(actor, now);
    const record: EventAnswer = {
      eventId: event.eventId,
      playerId,
      answer: choice.answer,
      ...(choice.sessionId ? { sessionId: choice.sessionId } : {}),
      answeredAt: options.answeredAt ?? now.toISOString(),
      source,
      ...(note ? { note } : {}),
    };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: eventKey(event.eventId),
                // Members write until the deadline; officers until the event starts. An import
                // writes whenever, because it records what happened, it does not answer late.
                ConditionExpression: options.historic
                  ? "attribute_exists(PK)"
                  : options.afterDeadline
                    ? "attribute_exists(PK) AND startsAt > :now"
                    : "attribute_exists(PK) AND deadlineAt > :now",
                ...(options.historic ? {} : { ExpressionAttributeValues: { ":now": now.toISOString() } }),
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(playerId),
                ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest, :unknown)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: WRITABLE_STATUSES,
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...answerKey(event.eventId, playerId),
                  ...answerIndexKey(playerId, event.startsAt, event.eventId),
                  type: "event-answer",
                  ...record,
                  ...meta,
                },
              },
            },
          ],
        }),
      );
      return record;
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") {
        throw new ConflictError(
          options.afterDeadline ? "The event has already started." : "Answers for this event are closed.",
        );
      }
      if (reasons?.[1] === "ConditionalCheckFailed") {
        throw new NotFoundError(`Game account ${playerId} can't answer (unknown or no longer active).`);
      }
      throw err;
    }
  }

  /**
   * Takes a seat for a login, or reports that it already had one. The counter and the seat item
   * change in one transaction, so the cap holds even when officers invite at the same time (FM-08).
   */
  async reserveSeat(sub: string, actor: Actor, cap: number = SEAT_CAP): Promise<"reserved" | "already"> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { ...seatKey(sub), type: "seat", sub, ...meta },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: seatCounterKey(),
                UpdateExpression: "SET #used = if_not_exists(#used, :zero) + :one, updatedAt = :now",
                ConditionExpression: "attribute_not_exists(#used) OR #used < :cap",
                ExpressionAttributeNames: { "#used": "used" },
                ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":cap": cap, ":now": meta.updatedAt },
              },
            },
          ],
        }),
      );
      return "reserved";
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") return "already";
      if (reasons?.[1] === "ConditionalCheckFailed") {
        throw new ConflictError(`All ${cap} sign-in seats are in use. Free one before inviting someone new.`);
      }
      throw err;
    }
  }

  /** Gives a seat back; used when creating a login succeeded but the seat did not. */
  async releaseSeat(sub: string): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.table,
              Key: seatKey(sub),
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: seatCounterKey(),
              UpdateExpression: "SET #used = #used - :one",
              ConditionExpression: "#used > :zero",
              ExpressionAttributeNames: { "#used": "used" },
              ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
            },
          },
        ],
      }),
    );
  }

  async seats(cap: number = SEAT_CAP): Promise<Seats> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: seatCounterKey() }));
    return { used: Number(res.Item?.used ?? 0), cap };
  }

  async linkedAccounts(sub: string): Promise<string[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `LOGIN#${sub}`, ":sk": "ACCOUNT#" },
    });
    return items.map((i) => String(i.playerId));
  }

  /**
   * Game accounts sharing one login represent one person in person-level analytics. The first
   * account linked is the display/main account; gameplay records themselves remain account-owned.
   */
  async linkedAccountGroups(playerIds: readonly string[]): Promise<string[][]> {
    const wanted = new Set(playerIds);
    if (wanted.size === 0) return [];
    const byLogin = new Map<string, { playerId: string; linkedAt: string }[]>();
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#type = :type",
          ExpressionAttributeNames: { "#type": "type", "#sub": "sub" },
          ExpressionAttributeValues: { ":type": "login-link" },
          ProjectionExpression: "#sub, playerId, createdAt",
          ExclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) {
        const sub = typeof item.sub === "string" ? item.sub : undefined;
        const playerId = typeof item.playerId === "string" ? item.playerId : undefined;
        if (!sub || !playerId || !wanted.has(playerId)) continue;
        const group = byLogin.get(sub) ?? [];
        group.push({ playerId, linkedAt: typeof item.createdAt === "string" ? item.createdAt : "" });
        byLogin.set(sub, group);
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return [...byLogin.values()].map((group) =>
      group
        .toSorted((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.playerId.localeCompare(b.playerId))
        .map((entry) => entry.playerId),
    );
  }

  /** The login already claiming this game account, without exposing it through the HTTP API. */
  async linkedLogin(playerId: string): Promise<string | undefined> {
    return (await this.linkedLoginAccess(playerId))?.sub;
  }

  /** Login metadata used for officer access management. The subject never leaves the API. */
  async linkedLoginAccess(playerId: string): Promise<{ sub: string; loginMethod: LoginMethod | null } | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: accountLinkLockKey(playerId) }));
    if (typeof res.Item?.sub !== "string") return undefined;
    const loginMethod = res.Item.loginMethod === "email" || res.Item.loginMethod === "password"
      ? res.Item.loginMethod
      : null;
    return { sub: res.Item.sub, loginMethod };
  }

  /** Starts an auditable password reset before Cognito is changed. */
  async startPasswordReset(
    playerId: string,
    justification: string,
    actor: Actor,
    requestedByName?: string,
  ): Promise<AccessAuditRecord> {
    const now = this.clock();
    const meta = newItemMeta({ ...actor, reason: "password reset requested" }, now);
    const record: AccessAuditRecord = {
      auditId: meta.changeId,
      playerId,
      action: "password_reset",
      status: "requested",
      justification,
      requestedAt: now.toISOString(),
      requestedBy: actor.id,
      ...(requestedByName ? { requestedByName } : {}),
    };
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { ...accessAuditKey(playerId, record.auditId), type: "access-audit", ...record, ...meta },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
    return record;
  }

  /** Resolves the audit entry after Cognito succeeds or fails. Passwords are never written here. */
  async finishPasswordReset(
    playerId: string,
    auditId: string,
    status: Exclude<PasswordResetStatus, "requested">,
    actor: Actor,
  ): Promise<AccessAuditRecord> {
    const now = this.clock();
    const meta = newItemMeta({ ...actor, reason: `password reset ${status}` }, now);
    const res = await this.db.send(new UpdateCommand({
      TableName: this.table,
      Key: accessAuditKey(playerId, auditId),
      UpdateExpression: "SET #status = :status, resolvedAt = :at, updatedAt = :at, updatedBy = :by, #via = :via, #reason = :reason, changeId = :changeId, version = version + :one",
      ConditionExpression: "attribute_exists(PK) AND #status = :requested",
      ExpressionAttributeNames: { "#status": "status", "#via": "via", "#reason": "reason" },
      ExpressionAttributeValues: {
        ":status": status,
        ":requested": "requested",
        ":at": now.toISOString(),
        ":by": actor.id,
        ":via": actor.via,
        ":reason": meta.reason,
        ":changeId": meta.changeId,
        ":one": 1,
      },
      ReturnValues: "ALL_NEW",
    }));
    return toAccessAudit(res.Attributes ?? {});
  }

  async listAccessAudit(playerId: string): Promise<AccessAuditRecord[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":sk": "ACCESS_AUDIT#" },
      ScanIndexForward: false,
    });
    return items.map(toAccessAudit);
  }

  /**
   * Adds an immutable report. One transaction:
   *  - the account must exist and accept data (active or guest; FM-12),
   *  - the report id must be new,
   *  - a correction marks the report it supersedes, which must belong to the same account
   *    and not already be superseded, so two concurrent corrections can't both win.
   */
  async addReport(report: Report, actor: Actor): Promise<void> {
    const now = this.clock();
    const meta = newItemMeta(actor, now);
    const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
      {
        ConditionCheck: {
          TableName: this.table,
          Key: accountKey(report.playerId),
          ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest, :unknown)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: WRITABLE_STATUSES,
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: { ...reportKey(report.playerId, report.reportId), type: "report", ...report, ...meta },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    if (report.supersedesReportId) {
      items.push({
        Update: {
          TableName: this.table,
          Key: reportKey(report.playerId, report.supersedesReportId),
          UpdateExpression: "SET supersededBy = :by, updatedAt = :now, version = version + :one",
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(supersededBy)",
          ExpressionAttributeValues: { ":by": report.reportId, ":now": now.toISOString(), ":one": 1 },
        },
      });
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") {
        throw new ConflictError(`Game account ${report.playerId} doesn't exist or doesn't accept new data.`);
      }
      if (reasons?.[1] === "ConditionalCheckFailed") throw new ConflictError("This report was already submitted.");
      if (reasons?.[2] === "ConditionalCheckFailed") {
        throw new ConflictError("The report to correct doesn't exist for this account or was already corrected.");
      }
      throw err;
    }
  }

  // ---- SvS buff slots (BUF-01..BUF-06) and kudos ----

  async putRound(round: SvsRound, actor: Actor): Promise<void> {
    const firstDate = [...round.days].map((d) => d.date).toSorted()[0]!;
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...svsRoundKey(round.roundId),
          ...svsRoundIndexKey(round.alliance, firstDate, round.roundId),
          type: "svs-round",
          ...round,
          ...newItemMeta(actor, this.clock()),
        },
      }),
    );
  }

  async getRound(roundId: string): Promise<SvsRound | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: svsRoundKey(roundId) }));
    return res.Item ? toRound(res.Item) : undefined;
  }

  /** Rounds of an alliance whose first buff day is on or after `from`, earliest first. */
  async listRounds(alliance: string, from: string, limit = 20): Promise<SvsRound[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK >= :from",
      ExpressionAttributeValues: { ":pk": `SVSROUNDS#${alliance}`, ":from": from },
      Limit: limit,
    });
    return items.map(toRound);
  }

  /**
   * Saves what someone can make. The deadline is checked in the same write, so a save that was
   * in flight when preferences closed is refused rather than slipping in (FM-09). Officers do not
   * edit preferences: after the deadline they assign slots instead.
   */
  async setPreferences(preferences: SlotPreferences, actor: Actor): Promise<SlotPreferences> {
    const now = this.clock();
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: svsRoundKey(preferences.roundId),
                ConditionExpression: "attribute_exists(PK) AND preferenceDeadline > :now",
                ExpressionAttributeValues: { ":now": now.toISOString() },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(preferences.playerId),
                ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest, :unknown)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: WRITABLE_STATUSES,
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...svsPreferencesKey(preferences.roundId, preferences.playerId),
                  type: "svs-preferences",
                  ...preferences,
                  ...newItemMeta(actor, now),
                },
              },
            },
          ],
        }),
      );
      return preferences;
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") throw new ConflictError("Preferences for this round are closed.");
      if (reasons?.[1] === "ConditionalCheckFailed") {
        throw new ConflictError(`Game account ${preferences.playerId} doesn't exist or doesn't accept new data.`);
      }
      throw err;
    }
  }

  async getPreferences(roundId: string, playerId: string): Promise<SlotPreferences | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: svsPreferencesKey(roundId, playerId) }),
    );
    return res.Item ? toPreferences(res.Item) : undefined;
  }

  async listPreferences(roundId: string): Promise<SlotPreferences[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `SVS#${roundId}`, ":sk": "PREF#" },
    });
    return items.map(toPreferences);
  }

  // ---- Distributable Fortress rewards ----

  async putFortressBuffPool(pool: FortressBuffPool, actor: Actor): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...fortressBuffPoolKey(pool.poolId),
          ...fortressBuffPoolIndexKey(pool.alliance, pool.acquiredAt, pool.poolId),
          type: "fortress-buff-pool",
          ...pool,
          ...newItemMeta(actor, this.clock()),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  /** One weekly entry either succeeds as a whole or leaves no partial inventory behind. */
  async putFortressBuffPools(pools: readonly FortressBuffPool[], actor: Actor): Promise<void> {
    if (pools.length === 0) return;
    const meta = newItemMeta(actor, this.clock());
    await this.db.send(new TransactWriteCommand({
      TransactItems: pools.map((pool) => ({
        Put: {
          TableName: this.table,
          Item: {
            ...fortressBuffPoolKey(pool.poolId),
            ...fortressBuffPoolIndexKey(pool.alliance, pool.acquiredAt, pool.poolId),
            type: "fortress-buff-pool",
            ...pool,
            ...meta,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      })),
    }));
  }

  /** Bot registration commits the complete haul and its retry marker as one transaction. */
  async putFortressBuffPoolsIdempotent(
    pools: readonly FortressBuffPool[],
    actor: Actor,
    tokenId: string,
    key: string,
    bodyHash: string,
  ): Promise<void> {
    if (pools.length === 0) return;
    const changedAt = this.clock();
    const meta = newItemMeta(actor, changedAt);
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: [
          ...pools.map((pool) => ({
            Put: {
              TableName: this.table,
              Item: {
                ...fortressBuffPoolKey(pool.poolId),
                ...fortressBuffPoolIndexKey(pool.alliance, pool.acquiredAt, pool.poolId),
                type: "fortress-buff-pool",
                ...pool,
                ...meta,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          })),
          {
            Put: {
              TableName: this.table,
              Item: {
                ...idempotencyKey(tokenId, key),
                type: "agent-idempotency",
                bodyHash,
                response: pools,
                createdAt: changedAt.toISOString(),
                expiresAtEpoch: Math.floor(changedAt.getTime() / 1000) + 24 * 60 * 60,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        throw new ConflictError("That reward batch or idempotency key already exists. Preview again before retrying.");
      }
      throw err;
    }
  }

  async getFortressBuffPool(poolId: string): Promise<FortressBuffPool | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: fortressBuffPoolKey(poolId) }));
    return res.Item ? toFortressBuffPool(res.Item) : undefined;
  }

  async listFortressBuffPools(alliance: string, limit = 50): Promise<FortressBuffPool[]> {
    const items = await this.queryAll({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `FORTBUFFS#${alliance}` },
      ScanIndexForward: false,
      Limit: limit,
    });
    return items.map(toFortressBuffPool);
  }

  async listFortressBuffAssignments(poolId: string): Promise<FortressBuffAssignment[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `FORTBUFF#${poolId}`, ":sk": "ASSIGN#" },
    });
    return items.map(toFortressBuffAssignment);
  }

  /** Decrements stock and records the recipient together, so the last reward units cannot be assigned twice. */
  async assignFortressBuff(
    assignment: FortressBuffAssignment,
    actor: Actor,
  ): Promise<FortressBuffAssignment> {
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: fortressBuffPoolKey(assignment.poolId),
                UpdateExpression:
                  "SET remaining = remaining - :amount, updatedAt = :updatedAt, updatedBy = :updatedBy, via = :via, changeId = :changeId, #version = if_not_exists(#version, :zero) + :one",
                ConditionExpression: "attribute_exists(PK) AND remaining >= :amount",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: {
                  ":one": 1,
                  ":amount": assignment.amount,
                  ":zero": 0,
                  ":updatedAt": meta.updatedAt,
                  ":updatedBy": meta.updatedBy,
                  ":via": meta.via,
                  ":changeId": meta.changeId,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(assignment.playerId),
                ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :unknown)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":active": "active", ":unknown": "unknown" },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...fortressBuffAssignmentKey(assignment.poolId, assignment.playerId),
                  type: "fortress-buff-assignment",
                  ...assignment,
                  ...meta,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return assignment;
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") throw new ConflictError("That reward batch has no buffs left.");
      if (reasons?.[1] === "ConditionalCheckFailed") throw new ConflictError("That account is not an active alliance member.");
      if (reasons?.[2] === "ConditionalCheckFailed") throw new ConflictError("That member already received this reward batch.");
      throw err;
    }
  }

  /** Marks a reserved recommendation as actually delivered in-game. */
  async confirmFortressBuffAssignment(
    poolId: string,
    playerId: string,
    confirmedAt: string,
    actor: Actor,
  ): Promise<FortressBuffAssignment> {
    const current = (await this.listFortressBuffAssignments(poolId)).find((item) => item.playerId === playerId);
    if (!current) throw new NotFoundError("Reward recommendation not found.");
    if (current.status === "confirmed") return current;
    const meta = newItemMeta(actor, this.clock());
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table,
        Key: fortressBuffAssignmentKey(poolId, playerId),
        UpdateExpression: "SET #status = :confirmed, confirmedAt = :confirmedAt, confirmedBy = :confirmedBy, updatedAt = :updatedAt, updatedBy = :updatedBy, via = :via, changeId = :changeId",
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(#status) OR #status = :recommended)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":confirmed": "confirmed",
          ":recommended": "recommended",
          ":confirmedAt": confirmedAt,
          ":confirmedBy": actor.id,
          ":updatedAt": meta.updatedAt,
          ":updatedBy": meta.updatedBy,
          ":via": meta.via,
          ":changeId": meta.changeId,
        },
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConflictError("That reward recommendation changed. Reload before confirming.");
      throw err;
    }
    return { ...current, status: "confirmed", confirmedAt, confirmedBy: actor.id };
  }

  /** Kudos are immutable: a mistake is corrected by awarding the opposite, never by editing. */
  async addKudos(award: KudosAward, actor: Actor): Promise<void> {
    try {
      const { reason: auditReason, ...meta } = newItemMeta(actor, this.clock());
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(award.playerId),
                ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest, :unknown)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: WRITABLE_STATUSES,
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...kudosKey(award.playerId, award.awardId),
                  type: "kudos",
                  ...award,
                  ...meta,
                  ...(auditReason ? { auditReason } : {}),
                },
                ConditionExpression: "attribute_not_exists(SK)",
              },
            },
          ],
        }),
      );
    } catch (err) {
      const reasons = cancellationCodes(err);
      if (reasons?.[0] === "ConditionalCheckFailed") {
        throw new ConflictError(`Game account ${award.playerId} doesn't exist or doesn't accept new data.`);
      }
      if (reasons?.[1] === "ConditionalCheckFailed") throw new ConflictError("That kudos was already recorded.");
      throw err;
    }
  }

  async listKudos(playerId: string): Promise<KudosAward[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":sk": "KUDOS#" },
    });
    return items.map(toKudos);
  }

  async listReports(playerId: string): Promise<Report[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":sk": "REPORT#" },
    });
    return items.map(toReport);
  }

  async getReport(playerId: string, reportId: string): Promise<Report | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: reportKey(playerId, reportId) }));
    return res.Item ? toReport(res.Item) : undefined;
  }

  /** Soft-deletes or restores a report while retaining the stream-backed audit history. */
  async setReportIgnored(playerId: string, reportId: string, ignored: boolean, actor: Actor, actorName: string): Promise<Report> {
    const meta = newItemMeta(actor, this.clock());
    try {
      const res = await this.db.send(new UpdateCommand({
        TableName: this.table,
        Key: reportKey(playerId, reportId),
        UpdateExpression: ignored
          ? "SET ignoredAt = :at, ignoredBy = :by, ignoredByName = :byName, ignoreReason = :ignoreReason, updatedAt = :at, updatedBy = :by, #via = :via, #reason = :reason, changeId = :changeId, #version = if_not_exists(#version, :zero) + :one"
          : "SET updatedAt = :at, updatedBy = :by, #via = :via, #reason = :reason, changeId = :changeId, #version = if_not_exists(#version, :zero) + :one REMOVE ignoredAt, ignoredBy, ignoredByName, ignoreReason",
        ConditionExpression: ignored
          ? "attribute_exists(PK) AND attribute_not_exists(ignoredAt)"
          : "attribute_exists(PK) AND attribute_exists(ignoredAt)",
        ExpressionAttributeNames: { "#via": "via", "#reason": "reason", "#version": "version" },
        ExpressionAttributeValues: {
          ":at": meta.updatedAt,
          ":by": actor.id,
          ":via": actor.via,
          ":reason": actor.reason,
          ":changeId": meta.changeId,
          ":zero": 0,
          ":one": 1,
          ...(ignored ? { ":byName": actorName, ":ignoreReason": actor.reason } : {}),
        },
        ReturnValues: "ALL_NEW",
      }));
      return toReport(res.Attributes ?? {});
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(ignored ? "That report is already ignored or no longer exists." : "That report is not ignored or no longer exists.");
      }
      throw err;
    }
  }

  /**
   * Every login that has at least one game account. Used once to give seats to logins that
   * existed before seats were counted; the table is alliance-sized, so a scan is fine.
   */
  async allLinkedLogins(): Promise<string[]> {
    const subs = new Set<string>();
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "#type = :type",
          // "sub" is a reserved word in DynamoDB expressions.
          ExpressionAttributeNames: { "#type": "type", "#sub": "sub" },
          ExpressionAttributeValues: { ":type": "login-link" },
          ProjectionExpression: "#sub",
          ExclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) if (item.sub) subs.add(String(item.sub));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return [...subs];
  }

  private async queryAll(
    params: Omit<ConstructorParameters<typeof QueryCommand>[0], "TableName">,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(new QueryCommand({ ...params, TableName: this.table, ExclusiveStartKey }));
      out.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  private async scanAll(
    params: Omit<ConstructorParameters<typeof ScanCommand>[0], "TableName">,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(new ScanCommand({ ...params, TableName: this.table, ExclusiveStartKey }));
      out.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
}

function cancellationCodes(err: unknown): (string | undefined)[] | undefined {
  if (err instanceof TransactionCanceledException) return err.CancellationReasons?.map((r) => r.Code);
  return undefined;
}

function toAccount(item: Record<string, unknown>): GameAccount {
  const account: GameAccount = {
    playerId: String(item.playerId),
    name: String(item.name),
    alliance: String(item.alliance),
    status: item.status as GameAccount["status"],
  };
  if (item.rank) account.rank = item.rank as NonNullable<GameAccount["rank"]>;
  if (item.note) account.note = String(item.note);
  // The audit stamp doubles as "since when this account was ours to account for".
  if (item.createdAt) account.createdAt = String(item.createdAt);
  return account;
}

function toReport(item: Record<string, unknown>): Report {
  const report: Report = {
    reportId: String(item.reportId),
    playerId: String(item.playerId),
    effectiveAt: String(item.effectiveAt),
    recordedAt: String(item.recordedAt),
    source: item.source as Report["source"],
    values: item.values as Report["values"],
  };
  if (item.supersedesReportId) report.supersedesReportId = String(item.supersedesReportId);
  if (item.note) report.note = String(item.note);
  if (item.ignoredAt) report.ignoredAt = String(item.ignoredAt);
  if (item.ignoredBy) report.ignoredBy = String(item.ignoredBy);
  if (item.ignoredByName) report.ignoredByName = String(item.ignoredByName);
  if (item.ignoreReason) report.ignoreReason = String(item.ignoreReason);
  return report;
}

function toRound(item: Record<string, unknown>): SvsRound {
  const round: SvsRound = {
    roundId: String(item.roundId),
    alliance: String(item.alliance),
    label: String(item.label),
    days: Array.isArray(item.days) ? (item.days as SvsRound["days"]) : [],
    preferenceDeadline: String(item.preferenceDeadline),
    createdBy: String(item.createdBy),
  };
  if (item.publishedAt) round.publishedAt = String(item.publishedAt);
  return round;
}

function toPreferences(item: Record<string, unknown>): SlotPreferences {
  return {
    roundId: String(item.roundId),
    playerId: String(item.playerId),
    days: Array.isArray(item.days) ? (item.days as SlotPreferences["days"]) : [],
    updatedAt: String(item.updatedAt),
  };
}

function toKudos(item: Record<string, unknown>): KudosAward {
  return {
    awardId: String(item.awardId),
    playerId: String(item.playerId),
    points: Number(item.points),
    reason: String(item.reason),
    awardedAt: String(item.awardedAt),
    awardedBy: String(item.awardedBy),
  };
}

function toFortressBuffPool(item: Record<string, unknown>): FortressBuffPool {
  const pool: FortressBuffPool = {
    poolId: String(item.poolId),
    alliance: String(item.alliance),
    buff: item.buff as FortressBuffPool["buff"],
    quantity: Number(item.quantity),
    remaining: Number(item.remaining),
    source: String(item.source),
    acquiredAt: String(item.acquiredAt),
    registeredAt: String(item.registeredAt ?? item.createdAt ?? item.acquiredAt),
    createdBy: String(item.createdBy),
  };
  if (item.batchId) pool.batchId = String(item.batchId);
  const valuation = item.gemValuation as FortressBuffPool["gemValuation"] | undefined
    ?? DEFAULT_REWARD_VALUATIONS[pool.buff];
  if (valuation) pool.gemValuation = valuation;
  return pool;
}

function toFortressBuffAssignment(item: Record<string, unknown>): FortressBuffAssignment {
  const assignment: FortressBuffAssignment = {
    poolId: String(item.poolId),
    playerId: String(item.playerId),
    amount: Number(item.amount ?? 1),
    assignedAt: String(item.assignedAt),
    assignedBy: String(item.assignedBy),
    status: item.status === "confirmed" ? "confirmed" : "recommended",
  };
  if (item.eligibility) assignment.eligibility = item.eligibility as NonNullable<FortressBuffAssignment["eligibility"]>;
  if (item.confirmedAt) assignment.confirmedAt = String(item.confirmedAt);
  if (item.confirmedBy) assignment.confirmedBy = String(item.confirmedBy);
  return assignment;
}

function toLineup(item: Record<string, unknown>): Lineup {
  const lineup: Lineup = {
    eventId: String(item.eventId),
    sessionId: String(item.sessionId),
    version: Number(item.version),
    entries: Array.isArray(item.entries) ? (item.entries as Lineup["entries"]) : [],
    publishedAt: String(item.publishedAt),
    publishedBy: String(item.publishedBy),
  };
  if (item.note) lineup.note = String(item.note);
  return lineup;
}

function toStrategy(item: Record<string, unknown>): Strategy {
  return {
    eventId: String(item.eventId),
    sessionId: String(item.sessionId),
    version: Number(item.version),
    body: String(item.body ?? ""),
    assignments: Array.isArray(item.assignments) ? (item.assignments as Strategy["assignments"]) : [],
    publishedAt: String(item.publishedAt),
    publishedBy: String(item.publishedBy),
  };
}

function toResult(item: Record<string, unknown>): EventResult {
  const result: EventResult = {
    eventId: String(item.eventId),
    sessionId: String(item.sessionId),
    version: Number(item.version),
    outcome: item.outcome as EventResult["outcome"],
    ourScore: Number(item.ourScore),
    opponentScore: Number(item.opponentScore),
    playerPoints: Array.isArray(item.playerPoints) ? (item.playerPoints as EventResult["playerPoints"]) : [],
    recordedAt: String(item.recordedAt),
    recordedBy: String(item.recordedBy),
  };
  if (item.ourMatchmakingPower !== undefined) result.ourMatchmakingPower = Number(item.ourMatchmakingPower);
  if (item.opponentMatchmakingPower !== undefined) result.opponentMatchmakingPower = Number(item.opponentMatchmakingPower);
  if (item.opponentCombatants !== undefined) result.opponentCombatants = Number(item.opponentCombatants);
  if (item.notes) result.notes = String(item.notes);
  return result;
}

function toAgentToken(item: Record<string, unknown>): AgentTokenRecord {
  const token: AgentTokenRecord = {
    tokenId: String(item.tokenId),
    name: String(item.name),
    tokenHash: String(item.tokenHash),
    scopes: Array.isArray(item.scopes) ? (item.scopes as AgentTokenRecord["scopes"]) : [],
    issuedBy: String(item.issuedBy),
    createdAt: String(item.createdAt),
    expiresAt: String(item.expiresAt),
  };
  if (item.lastUsedAt) token.lastUsedAt = String(item.lastUsedAt);
  if (item.revokedAt) token.revokedAt = String(item.revokedAt);
  return token;
}

function toHistoricalRecord(item: Record<string, unknown>): HistoricalRecord {
  const record: HistoricalRecord = {
    recordId: String(item.recordId),
    category: item.category as HistoricalRecord["category"],
    sourceId: String(item.sourceId),
    payload: item.payload,
  };
  if (item.occurredAt) record.occurredAt = String(item.occurredAt);
  if (item.playerId) record.playerId = String(item.playerId);
  if (item.eventId) record.eventId = String(item.eventId);
  if (item.sessionId) record.sessionId = String(item.sessionId);
  if (item.evidenceId) record.evidenceId = String(item.evidenceId);
  if (item.reviewStatus) record.reviewStatus = String(item.reviewStatus);
  if (item.confidence !== undefined) record.confidence = Number(item.confidence);
  return record;
}

function toChecklist(item: Record<string, unknown>): Checklist {
  return {
    eventId: String(item.eventId),
    version: Number(item.version ?? 1),
    entries: Array.isArray(item.entries) ? (item.entries as Checklist["entries"]) : [],
    updatedAt: String(item.updatedAt),
  };
}

function toEvent(item: Record<string, unknown>): AllianceEvent {
  const event: AllianceEvent = {
    eventId: String(item.eventId),
    alliance: String(item.alliance),
    kind: item.kind as AllianceEvent["kind"],
    title: String(item.title),
    startsAt: String(item.startsAt),
    deadlineAt: String(item.deadlineAt),
    // Events created before sessions existed simply have none.
    sessions: Array.isArray(item.sessions) ? (item.sessions as AllianceEvent["sessions"]) : [],
    createdBy: String(item.createdBy),
  };
  if (item.notes) event.notes = String(item.notes);
  if (item.ownerPlayerId) event.ownerPlayerId = String(item.ownerPlayerId);
  // The item's own audit stamp doubles as "when members could first answer".
  if (item.createdAt) event.createdAt = String(item.createdAt);
  return event;
}

function toAnswer(item: Record<string, unknown>): EventAnswer {
  const answer: EventAnswer = {
    eventId: String(item.eventId),
    playerId: String(item.playerId),
    answer: item.answer as EventAnswer["answer"],
    answeredAt: String(item.answeredAt),
    source: item.source as EventAnswer["source"],
  };
  if (item.sessionId) answer.sessionId = String(item.sessionId);
  if (item.note) answer.note = String(item.note);
  return answer;
}

function toEventType(item: Record<string, unknown>): EventType {
  const type: EventType = {
    typeId: String(item.typeId),
    name: String(item.name),
    leadDays: Number(item.leadDays ?? 0),
    sessions: Array.isArray(item.sessions) ? (item.sessions as EventType["sessions"]) : [],
    archived: Boolean(item.archived),
    createdBy: String(item.createdBy),
  };
  if (item.strategyTemplate) type.strategyTemplate = String(item.strategyTemplate);
  if (Array.isArray(item.checklist)) type.checklist = item.checklist as NonNullable<EventType["checklist"]>;
  return type;
}

function toAttendance(item: Record<string, unknown>): AttendanceRecord {
  const record: AttendanceRecord = {
    eventId: String(item.eventId),
    playerId: String(item.playerId),
    status: item.status as AttendanceRecord["status"],
    source: item.source as AttendanceRecord["source"],
    recordedAt: String(item.recordedAt),
  };
  if (item.sessionId) record.sessionId = String(item.sessionId);
  if (item.note) record.note = String(item.note);
  if (item.evidenceRef) record.evidenceRef = String(item.evidenceRef);
  return record;
}

function toAccessAudit(item: Record<string, unknown>): AccessAuditRecord {
  const record: AccessAuditRecord = {
    auditId: String(item.auditId),
    playerId: String(item.playerId),
    action: "password_reset",
    status: item.status as AccessAuditRecord["status"],
    justification: String(item.justification),
    requestedAt: String(item.requestedAt),
    requestedBy: String(item.requestedBy),
  };
  if (item.resolvedAt) record.resolvedAt = String(item.resolvedAt);
  if (item.requestedByName) record.requestedByName = String(item.requestedByName);
  return record;
}
