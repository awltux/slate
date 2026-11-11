import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { SlateError } from "../../domain/result.js";
import type { ProjectPaths } from "./paths.js";

export const CommitRecordSchema = z
  .object({
    id: z.string().startsWith("cmt_"),
    parent: z.string().startsWith("cmt_").nullable(),
    at: z.string(),
    actor: z.string(),
    intent: z.string(),
    revision: z.number().int().nonnegative(),
    touched: z.array(z.string()),
    /**
     * What the operation actually sent or received, as labelled strings: a prompt, a response, the model that answered.
     * Kept on the commit because "why does this picture not look like the film" is answered by the words, not the hash.
     */
    detail: z.record(z.string(), z.string()).optional(),
    projectHash: z.string().nullable(),
    productionHash: z.string().nullable(),
  })
  .strict();

export type CommitRecord = z.infer<typeof CommitRecordSchema>;

/**
 * Append one commit and fsync it. The log is the authority for recovery: a document without a matching record is
 * rolled back on open rather than trusted.
 */
export async function appendCommit(paths: ProjectPaths, record: CommitRecord): Promise<void> {
  const parsed = CommitRecordSchema.parse(record);
  const handle = await open(paths.commitsFile, "a");
  try {
    await handle.write(`${JSON.stringify(parsed)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readCommits(paths: ProjectPaths): Promise<CommitRecord[]> {
  let raw: string;
  try {
    raw = await readFile(paths.commitsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: CommitRecord[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SlateError("invalid_document", `commit log line ${index + 1} is not JSON`, {
        detail: { file: "commits.jsonl", line: index + 1 },
      });
    }
    const result = CommitRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new SlateError("invalid_document", `commit log line ${index + 1} is malformed`, {
        detail: { file: "commits.jsonl", line: index + 1 },
      });
    }
    records.push(result.data);
  }
  return records;
}

export async function latestCommit(paths: ProjectPaths): Promise<CommitRecord | null> {
  const records = await readCommits(paths);
  return records.at(-1) ?? null;
}
