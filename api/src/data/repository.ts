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
import type { AllianceEvent, Answer, EventAnswer } from "../domain/events.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { searchKey } from "../domain/identity.js";
import type { Report } from "../domain/measurements.js";
import { SEAT_CAP, type Seats } from "../domain/seats.js";
import {
  accountKey,
  answerIndexKey,
  answerKey,
  accountLinkLockKey,
  allianceIndexKey,
  eventIndexKey,
  eventKey,
  loginLinkKey,
  reportKey,
  seatCounterKey,
  seatKey,
} from "./keys.js";
import { newItemMeta, type Actor } from "./meta.js";

/** Accounts that may receive new data: active members and guests (FM-12). */
const WRITABLE_STATUSES = { ":active": "active", ":guest": "guest" };

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
   * Records an answer. The event must exist and its deadline must still be open at the moment
   * of the write, so a late answer can't slip through between reading and writing (FM-09).
   */
  async setAnswer(
    event: Pick<AllianceEvent, "eventId" | "startsAt" | "deadlineAt">,
    playerId: string,
    answer: Answer,
    source: EventAnswer["source"],
    actor: Actor,
    note?: string,
  ): Promise<EventAnswer> {
    const now = this.clock();
    const meta = newItemMeta(actor, now);
    const record: EventAnswer = {
      eventId: event.eventId,
      playerId,
      answer,
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
                ConditionExpression: "attribute_exists(PK) AND deadlineAt > :now",
                ExpressionAttributeValues: { ":now": now.toISOString() },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: accountKey(playerId),
                ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest)",
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
        throw new ConflictError("Answers for this event are closed.");
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
          ConditionExpression: "attribute_exists(PK) AND #status IN (:active, :guest)",
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

function toEvent(item: Record<string, unknown>): AllianceEvent {
  const event: AllianceEvent = {
    eventId: String(item.eventId),
    alliance: String(item.alliance),
    kind: item.kind as AllianceEvent["kind"],
    title: String(item.title),
    startsAt: String(item.startsAt),
    deadlineAt: String(item.deadlineAt),
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
  if (item.note) answer.note = String(item.note);
  return answer;
}
