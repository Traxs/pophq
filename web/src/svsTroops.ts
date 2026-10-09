import type { EventMember, MeasurementValue } from "./api";
import { TROOP_LABELS, TROOP_TYPES } from "./troops";

export function missingSvsTroopDetails(current: Record<string, (MeasurementValue & { effectiveAt: string }) | undefined>): string[] {
  const missing: string[] = [];
  if (!current.furnace_level?.value) missing.push("furnace level");
  for (const type of TROOP_TYPES) {
    if (!current[`troop_level_${type}`]?.value) missing.push(`${TROOP_LABELS[type]} FC`);
    if (current[`helios_${type}`]?.value !== "yes" && current[`helios_${type}`]?.value !== "no") {
      missing.push(`${TROOP_LABELS[type]} Helios`);
    }
  }
  return missing;
}

export function missingMemberTroopDetails(member: EventMember): string[] {
  const missing: string[] = [];
  if (!member.furnace) missing.push("Furnace");
  for (const type of TROOP_TYPES) {
    if (!member.troops?.[type]?.level) missing.push(TROOP_LABELS[type]);
    if (member.troops?.[type]?.helios === null || member.troops?.[type]?.helios === undefined) missing.push(`${TROOP_LABELS[type]} Helios`);
  }
  return missing;
}

export function svsTroopRequestMessage(powerUrl: string): string {
  return [
    "📢 POPers! Please update your SvS troop details in POP HQ:",
    "",
    "🔹 Furnace level",
    "🔹 Infantry FC level + Helios (yes/no)",
    "🔹 Lancer FC level + Helios (yes/no)",
    "🔹 Marksman FC level + Helios (yes/no)",
    "",
    `Update here: ${powerUrl}`,
    "",
    "This helps us organize rallies and reinforcements without repeatedly asking in chat. Thank you! 💕💪",
  ].join("\n");
}
