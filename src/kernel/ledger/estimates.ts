import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hashValue } from "../../domain/canonical.js";
import { SlateError } from "../../domain/result.js";
import { writeFileAtomic } from "../workspace/atomic.js";
import type { ProjectPaths } from "../workspace/paths.js";

export const EstimateItemSchema = z
  .object({
    shotId: z.string(),
    endpointId: z.string(),
    durationSec: z.number().positive(),
    usd: z.number().nonnegative(),
  })
  .strict();

export const EstimateRecordSchema = z
  .object({
    id: z.string().startsWith("est_"),
    createdAt: z.string(),
    expiresAt: z.string(),
    tier: z.enum(["draft", "final"]),
    items: z.array(EstimateItemSchema),
    usd: z.number().nonnegative(),
    /** Hash of the priced content: an approval binds to this, so changing the plan invalidates the token. */
    hash: z.string(),
  })
  .strict();

export type EstimateRecord = z.infer<typeof EstimateRecordSchema>;

export function estimatesDir(paths: ProjectPaths): string {
  return join(paths.slateDir, "estimates");
}

export function estimateFile(paths: ProjectPaths, id: string): string {
  return join(estimatesDir(paths), `${id}.json`);
}

export function estimateHash(
  tier: string,
  items: Array<{ shotId: string; endpointId: string; durationSec: number }>,
): string {
  return hashValue({ tier, items });
}

export async function writeEstimate(paths: ProjectPaths, estimate: EstimateRecord): Promise<void> {
  await writeFileAtomic(estimateFile(paths, estimate.id), `${JSON.stringify(estimate, null, 2)}\n`);
}

export async function readEstimate(paths: ProjectPaths, id: string): Promise<EstimateRecord> {
  let raw: string;
  try {
    raw = await readFile(estimateFile(paths, id), "utf8");
  } catch {
    throw new SlateError("not_found", `no estimate ${id}`);
  }
  const parsed = EstimateRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new SlateError("invalid_document", `estimate ${id} is malformed`);
  return parsed.data;
}
