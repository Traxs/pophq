import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DataConfig {
  tableName: string;
  /** Set only for local development and tests (DynamoDB Local). */
  endpoint?: string;
  region: string;
}

export function dataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DataConfig {
  const config: DataConfig = {
    tableName: env.TABLE_NAME ?? "pophq-local",
    region: env.AWS_REGION ?? "eu-central-1",
  };
  if (env.DYNAMODB_ENDPOINT) config.endpoint = env.DYNAMODB_ENDPOINT;
  return config;
}

export function createBaseClient(config: DataConfig): DynamoDBClient {
  return new DynamoDBClient({
    region: config.region,
    ...(config.endpoint
      ? {
          endpoint: config.endpoint,
          // DynamoDB Local accepts any credentials; these are not secrets.
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  });
}

export function createDocClient(base: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
}
