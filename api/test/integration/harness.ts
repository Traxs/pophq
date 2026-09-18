// Shared setup for integration tests: a fresh DynamoDB Local table per test file,
// and an in-process token issuer so tests don't depend on the local OIDC container.
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT } from "jose";
import { ulid } from "ulid";
import { createBaseClient, createDocClient } from "../../src/data/client.js";
import { Repository } from "../../src/data/repository.js";
import { createTable, deleteTable } from "../../src/data/table.js";
import { createVerifier } from "../../src/http/auth.js";
import { createApp } from "../../src/http/app.js";
import { registerDevRoutes } from "../../src/dev/routes.js";

const ISSUER = "https://issuer.test";

export async function createHarness(opts: { devTools?: boolean; isPaused?: () => Promise<boolean> } = {}) {
  const config = {
    tableName: `pophq-test-${ulid().toLowerCase()}`,
    region: "eu-central-1",
    endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  };
  const base = createBaseClient(config);
  await createTable(base, config.tableName);
  const db = createDocClient(base);
  const repo = new Repository(db, config.tableName);

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const verifier = createVerifier({ issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }) });
  const app = createApp({
    repo,
    verifier,
    ...(opts.devTools ? { extend: (a) => registerDevRoutes(a, { repo, reset: async () => {} }) } : {}),
    ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
  });

  const token = (sub: string, groups: string[] = []) =>
    new SignJWT({ groups })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const call = async (
    method: string,
    path: string,
    opts: { as?: string; groups?: string[]; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.as) headers.authorization = `Bearer ${await token(opts.as, opts.groups)}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(`/v1${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  return {
    repo,
    db,
    tableName: config.tableName,
    call,
    token,
    cleanup: () => deleteTable(base, config.tableName),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
