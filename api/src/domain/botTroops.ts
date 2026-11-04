import { z } from "zod";
import { currentValues, parseReport, TROOP_TYPES, type Report } from "./measurements.js";
import { ValidationError } from "./errors.js";

const troop = z.object({ level: z.string().optional(), helios: z.boolean().optional() }).strict()
  .refine(v => v.level !== undefined || v.helios !== undefined, "Supply a level or Helios flag.");
const input = z.object({
  effectiveAt: z.iso.datetime({ offset: true }),
  sourceReference: z.string().trim().min(3).max(300),
  troops: z.object({ infantry: troop.optional(), lancer: troop.optional(), marksman: troop.optional() }).strict()
    .refine(v => Object.keys(v).length > 0, "Supply at least one troop type."),
  reason: z.string().trim().max(300).optional(),
  expectedHash: z.string().optional(),
  approved: z.boolean().optional(),
}).strict();
const rank = (level: string) => {
  const fc = /^FC(\d+)(?:-(\d))?$/.exec(level);
  return fc ? 30 + Number(fc[1]) + Number(fc[2] ?? 0) / 10 : Number(level);
};
export function planBotTroops(body: unknown, playerId: string, reports: Report[], now: Date) {
  const parsed = input.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid troop report.", z.flattenError(parsed.error).fieldErrors);
  const data = parsed.data;
  if (Date.parse(data.effectiveAt) > now.getTime()) throw new ValidationError("Troop observations cannot be in the future.");
  const effective = new Date(data.effectiveAt).toISOString();
  const before = currentValues(reports);
  const observed = currentValues(reports.filter(r => r.effectiveAt <= effective));
  const values = TROOP_TYPES.flatMap(type => {
    const v = data.troops[type];
    return [
      ...(v?.level !== undefined ? [{metric: `troop_level_${type}`, value: v.level}] : []),
      ...(v?.helios !== undefined ? [{metric: `helios_${type}`, value: v.helios}] : []),
    ];
  });
  const report = parseReport({ effectiveAt: effective, values, note: `Source: ${data.sourceReference}` },
    {playerId, reportId: "preview", source: "hermes", now});
  for (const v of report.values.filter(v => v.metric.startsWith("troop_level_"))) {
    const furnace = observed.furnace_level?.value;
    if (!furnace) throw new ValidationError("Record the player's furnace level for this observation date before updating troop FC levels.");
    if (rank(String(v.value)) > rank(String(furnace))) throw new ValidationError(`${v.metric} cannot exceed furnace ${furnace}.`);
  }
  return {
    report,
    review: {playerId, effectiveAt: effective, sourceReference: data.sourceReference,
      values: report.values, before, after: currentValues([...reports, report])},
  };
}
