import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { UnauthorizedError } from "../domain/errors.js";

export interface VerifiedToken {
  sub: string;
  groups: unknown;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

export interface VerifierOptions {
  issuer: string;
  keys: JWTVerifyGetKey;
  /** Expected audience or client id, if the issuer sets one. */
  audience?: string;
}

/**
 * Verifies signature, issuer, expiry and (optionally) audience. Groups come from
 * `cognito:groups` in AWS and `groups` from the local issuer.
 */
export function createVerifier(opts: VerifierOptions): TokenVerifier {
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, opts.keys, {
        issuer: opts.issuer,
        ...(opts.audience ? { audience: opts.audience } : {}),
        algorithms: ["RS256", "ES256"],
      }));
    } catch {
      throw new UnauthorizedError("Invalid or expired token.");
    }
    if (!payload.sub) throw new UnauthorizedError("Token has no subject.");
    return { sub: payload.sub, groups: payload["cognito:groups"] ?? payload.groups };
  };
}

/** Discovers the issuer's JWKS URL (OIDC discovery) on first use; works for Cognito and the local issuer. */
export function createRemoteVerifier(issuer: string, audience?: string): TokenVerifier {
  let verifier: Promise<TokenVerifier> | undefined;
  const init = async (): Promise<TokenVerifier> => {
    const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
    const { jwks_uri } = (await res.json()) as { jwks_uri: string };
    return createVerifier({ issuer, keys: createRemoteJWKSet(new URL(jwks_uri)), ...(audience ? { audience } : {}) });
  };
  return async (token) => {
    verifier ??= init().catch((err: unknown) => {
      verifier = undefined; // retry discovery on the next request
      throw err;
    });
    return (await verifier)(token);
  };
}
