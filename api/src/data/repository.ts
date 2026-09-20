import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { GameAccount } from "../domain/accounts.js";
import type { AttendanceRecord } from "../domain/attendance.js";
import type { AllianceEvent, Answer, EventAnswer } from "../domain/events.js";
import type { EventType } from "../domain/eventTypes.js";
import type { Lineup } from "../domain/lineups.js";
import type { Strategy } from "../domain/strategy.js";
import type { EventResult } from "../domain/results.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { searchKey } from "../domain/identity.js";
import type { Report } from "../domain/measurements.js";
import { SEAT_CAP, type Seats } from "../domain/seats.js";
import {
  accountKey,
  answerIndexKey,
  answerKey,
  attendanceIndexKey,
  attendanceKey,
  accountLinkLockKey,
  allianceIndexKey,
  eventIndexKey,
  eventKey,
  eventTypeKey,
  lineupKey,
  loginLinkKey,
  reportKey,
  resultKey,
  seatCounterKey,
  seatKey,
  strategyKey,
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
  async linkAccount(sub: string, playerId: string, actor: Actor): Promise<void> {
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
                Item: { ...accountLinkLockKey(playerId), type: "link-lock", sub, ...meta },
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

  async listAnswers(eventId: string): Promise<EventAnswer[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "ANSWER#" },
    });
    return items.map(toAnswer);
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
    options: { afterDeadline?: boolean; historic?: boolean } = {},
  ): Promise<EventAnswer> {
    const now = this.clock();
    const meta = newItemMeta(actor, now);
    const record: EventAnswer = {
      eventId: event.eventId,
      playerId,
      answer: choice.answer,
      ...(choice.sessionId ? { sessionId: choice.sessionId } : {}),
      answeredAt: now.toISOString(),
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

  async listReports(playerId: string): Promise<Report[]> {
    const items = await this.queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${playerId}`, ":sk": "REPORT#" },
    });
    return items.map(toReport);
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
  return report;
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
