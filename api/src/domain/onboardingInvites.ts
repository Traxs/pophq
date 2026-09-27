import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "./errors.js";

export const ONBOARDING_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const ONBOARDING_TOKEN_BYTES = 32;

export type OnboardingInviteStatus = "issued" | "redeeming" | "redeemed" | "failed";
export type OnboardingLoginMethod = "email" | "password";

export interface OnboardingInvite {
  inviteId: string;
  playerId: string;
  playerName: string;
  status: OnboardingInviteStatus;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  expiresAtEpoch: number;
  method?: OnboardingLoginMethod;
  redeemedAt?: string;
  failedAt?: string;
  failureCode?: string;
}

/** A 256-bit bearer secret. Only its SHA-256 digest is persisted. */
export function createOnboardingToken(): { token: string; tokenHash: string } {
  const token = randomBytes(ONBOARDING_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashOnboardingToken(token) };
}

export function parseOnboardingToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  // randomBytes(32).toString("base64url") is always 43 characters. Keeping this exact avoids
  // hashing arbitrarily large attacker-controlled values on the public endpoints.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ValidationError("This invitation is invalid or has expired.");
  return token;
}

export function hashOnboardingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseOnboardingMethod(value: unknown): OnboardingLoginMethod {
  if (value !== "email" && value !== "password") throw new ValidationError("Choose email code or password access.");
  return value;
}

/** Friendly prefix used inside the pool's required email-format private login identifier. */
export function parsePrivateLoginName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,22}[a-z0-9])?$/.test(name)) {
    throw new ValidationError("Choose a login name with 3–24 letters, numbers, dots, dashes or underscores.");
  }
  return name;
}
