// Local stand-in for Cognito: remembers invited logins in DynamoDB Local so the invite flow
// can be tried end to end without AWS. Never used on AWS.
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LoginDirectory } from "../ops/invite.js";
import { randomBytes } from "node:crypto";

const key = (email: string) => ({ PK: `DEVLOGIN#${email}`, SK: "PROFILE" });

export function devLogins(db: DynamoDBDocumentClient, table: string): LoginDirectory {
  return {
    async findSub(email) {
      const res = await db.send(new GetCommand({ TableName: table, Key: key(email) }));
      return res.Item?.sub as string | undefined;
    },
    async createLogin(email) {
      const sub = `local-${email}`;
      await db.send(new PutCommand({ TableName: table, Item: { ...key(email), type: "dev-login", sub, email } }));
      return sub;
    },
    async createPasswordLogin() {
      const username = `member-${randomBytes(6).toString("hex")}@members.pophq.invalid`;
      const password = `${randomBytes(12).toString("base64url")}Aa1!`;
      const sub = `local-${username}`;
      await db.send(new PutCommand({ TableName: table, Item: { ...key(username), type: "dev-login", sub, email: username } }));
      return { sub, username, password };
    },
    async deleteLogin(sub) {
      const email = sub.replace(/^local-/, "");
      await db.send(new DeleteCommand({ TableName: table, Key: key(email) }));
    },
  };
}
