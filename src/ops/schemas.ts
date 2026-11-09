import { z } from "zod";

export const ReadinessCheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
  })
  .strict();

export const ReadinessSummarySchema = z
  .object({ pass: z.number().int(), warn: z.number().int(), fail: z.number().int() })
  .strict();

export const ShotSummarySchema = z
  .object({
    id: z.string(),
    number: z.string(),
    size: z.string(),
    angle: z.string(),
    movement: z.string(),
    durationSec: z.number(),
    description: z.string(),
    stale: z.boolean(),
    staleCause: z.string().nullable(),
    readiness: ReadinessSummarySchema,
  })
  .strict();

export const SceneSummarySchema = z
  .object({
    id: z.string(),
    number: z.number().int(),
    heading: z.object({ intExt: z.string(), location: z.string(), timeOfDay: z.string() }).strict(),
    synopsis: z.string(),
    body: z.string(),
    staleCount: z.number().int(),
    shots: z.array(ShotSummarySchema),
  })
  .strict();
