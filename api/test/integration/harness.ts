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

import { HistoryStore } from "../../src/data/history.js";
import type { LoginDirectory } from "../../src/ops/invite.js";
import type { BotIssuerGroups } from "../../src/http/agentAuth.js";
import type { EvidenceContent, EvidenceObject, EvidenceStore } from "../../src/ops/evidenceStore.js";

export async function createHarness(
  opts: { devTools?: boolean; isPaused?: () => Promise<boolean>; logins?: LoginDirectory; history?: boolean; botIssuerGroups?: BotIssuerGroups } = {},
) {
  const config = {
    tableName: `pophq-test-${ulid().toLowerCase()}`,
    region: "eu-central-1",
    endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  };
  const base = createBaseClient(config);
  await createTable(base, config.tableName);
  const db = createDocClient(base);
  const repo = new Repository(db, config.tableName);
  const evidenceObjects = new Map<string, EvidenceContent>();
  const evidence: EvidenceStore = {
    head: async (recordId) => {
      const found = evidenceObjects.get(recordId);
      if (!found) return undefined;
      return { recordId: found.recordId, sha256: found.sha256, size: found.size, contentType: found.contentType };
    },
    get: async (recordId) => {
      const found = evidenceObjects.get(recordId);
      if (!found) throw new Error("Evidence content not found.");
      return found;
    },
    put: async (record: EvidenceObject, content: Uint8Array) => {
      if (evidenceObjects.has(record.recordId)) throw new Error("Evidence already exists.");
      evidenceObjects.set(record.recordId, { ...record, content });
    },
  };

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const verifier = createVerifier({ issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }) });
  const app = createApp({
    repo,
    verifier,
    ...(opts.devTools ? { extend: (a) => registerDevRoutes(a, { repo, reset: async () => {} }) } : {}),
    ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
    ...(opts.logins ? { logins: opts.logins } : {}),
    ...(opts.botIssuerGroups ? { botIssuerGroups: opts.botIssuerGroups } : {}),
    // The history table is separate in AWS; locally the same table serves, since the keys differ.
    ...(opts.history ? { history: new HistoryStore(db, config.tableName) } : {}),
    evidence,
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
    evidenceObjects,
    cleanup: () => deleteTable(base, config.tableName),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
