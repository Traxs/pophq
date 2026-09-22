import { ValidationError } from "./errors.js";

export type LoginMethod = "email" | "password";
export type PasswordResetStatus = "requested" | "completed" | "failed";

export interface AccessAuditRecord {
  auditId: string;
  playerId: string;
  action: "password_reset";
  status: PasswordResetStatus;
  justification: string;
  requestedAt: string;
  requestedBy: string;
  requestedByName?: string;
  resolvedAt?: string;
}

/** A reason makes an unusual reset explainable during a later fraud review. */
export function parseResetJustification(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 5 || reason.length > 200) {
    throw new ValidationError("Explain the reset in 5 to 200 characters.");
  }
  return reason;
}
