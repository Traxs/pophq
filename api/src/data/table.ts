import {
  CreateTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/**
 * Creates the main table for local development and tests. In AWS the table is defined in CDK;
 * keep both definitions in sync (keys, GSI1, stream view type).
 */
export async function createTable(client: DynamoDBClient, tableName: string): Promise<"created" | "exists"> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
      }),
    );
  } catch (err) {
    if (err instanceof ResourceInUseException) return "exists";
    throw err;
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  return "created";
}

export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
  await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}
