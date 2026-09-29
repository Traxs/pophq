import type { SignUpEntry } from "./api";

/** Keeps an explicit officer designation distinct from the capacity-based estimate. */
export function registrationRolePresentation(entry: Pick<SignUpEntry, "likely" | "registrationRole">) {
  if (entry.registrationRole === "substitute") return { label: "Substitute · officer", tone: "warn" as const };
  return entry.likely === "starter"
    ? { label: "Likely starter", tone: "up" as const }
    : { label: "Likely sub", tone: "warn" as const };
}
