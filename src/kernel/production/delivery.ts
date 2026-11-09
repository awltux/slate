import { z } from "zod";

export const QcCheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
  })
  .strict();

export type QcCheck = z.infer<typeof QcCheckSchema>;

export const DeliverySchema = z
  .object({
    assetId: z.string().startsWith("ast_"),
    at: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationSec: z.number().nonnegative(),
    bytes: z.number().int().nonnegative(),
    codec: z.string(),
    audio: z.boolean(),
    qc: z.array(QcCheckSchema),
    manifestPath: z.string(),
  })
  .strict();

export type Delivery = z.infer<typeof DeliverySchema>;

export const PROVENANCE_SCHEMA = "slate.provenance.v1";
