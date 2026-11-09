import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { SlateError } from "../../domain/result.js";
import type { ProjectPaths } from "../workspace/paths.js";

export const LedgerEntrySchema = z
  .object({
    at: z.string(),
    kind: z.enum(["estimate", "approval", "reservation", "settlement", "refund"]),
    actor: z.string(),
    usd: z.number(),
    estimateId: z.string().nullable(),
    jobId: z.string().nullable(),
    note: z.string(),
  })
  .strict();

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export async function readLedger(paths: ProjectPaths): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(paths.ledgerFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: LedgerEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new SlateError("invalid_document", `ledger line ${index + 1} is malformed`, {
        detail: { file: "ledger.jsonl", line: index + 1 },
      });
    }
    entries.push(parsed.data);
  }
  return entries;
}

/** Append and fsync: money records must survive a crash even when the document write does not. */
export async function appendLedger(paths: ProjectPaths, entry: LedgerEntry): Promise<void> {
  const parsed = LedgerEntrySchema.parse(entry);
  const handle = await open(paths.ledgerFile, "a");
  try {
    await handle.write(`${JSON.stringify(parsed)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * What the project has committed to spend: reservations minus refunds, plus settlements. An approval on its own
 * costs nothing — only a reservation does, which is why the ceiling is checked when a job is submitted.
 */
export function committedUsd(entries: LedgerEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "reservation" || entry.kind === "settlement") total += entry.usd;
    if (entry.kind === "refund") total -= entry.usd;
  }
  return Math.round(total * 100) / 100;
}

export function remainingUsd(ceilingUsd: number, entries: LedgerEntry[]): number {
  return Math.round((ceilingUsd - committedUsd(entries)) * 100) / 100;
}

export function wasEstimateConsumed(entries: LedgerEntry[], estimateId: string): boolean {
  return entries.some((entry) => entry.kind === "reservation" && entry.estimateId === estimateId);
}
