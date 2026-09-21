import { z } from "zod";
import { ValidationError } from "./errors.js";

export const HISTORICAL_CATEGORIES = [
  "alias",
  "relationship",
  "membership",
  "registration",
  "selection",
  "assignment",
  "performance",
  "evidence",
] as const;

export type HistoricalCategory = (typeof HISTORICAL_CATEGORIES)[number];

export interface HistoricalRecord {
  recordId: string;
  category: HistoricalCategory;
  sourceId: string;
  payload: z.infer<typeof JsonValueSchema>;
  occurredAt?: string;
  playerId?: string;
  eventId?: string;
  sessionId?: string;
  evidenceId?: string;
  reviewStatus?: string;
  confidence?: number;
}

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

const Schema = z.object({
  category: z.enum(HISTORICAL_CATEGORIES),
  sourceId: z.string().trim().min(1).max(200),
  payload: JsonValueSchema,
  occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  playerId: z.string().trim().regex(/^\d{6,20}$/).optional(),
  eventId: z.string().trim().min(3).max(80).optional(),
  sessionId: z.string().trim().max(8).optional(),
  evidenceId: z.string().trim().max(200).optional(),
  reviewStatus: z.string().trim().max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function parseHistoricalRecord(recordId: string, input: unknown): HistoricalRecord {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(recordId)) throw new ValidationError("Invalid historical record id.");
  const parsed = Schema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid historical record.", z.flattenError(parsed.error).fieldErrors);
  if (JSON.stringify(parsed.data.payload).length > 100_000) throw new ValidationError("Historical record payload is too large.");
  return { recordId, ...parsed.data } as HistoricalRecord;
}
