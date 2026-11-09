import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SlateError } from "../../domain/result.js";
import { projectPaths } from "./paths.js";

export const ProjectSettingsSchema = z
  .object({
    runtimeSeconds: z.number().positive(),
    aspectRatio: z.string().regex(/^\d+:\d+$/u, "aspect ratio must look like 16:9"),
  })
  .strict();

export const BudgetSchema = z
  .object({
    currency: z.literal("USD"),
    ceilingUsd: z.number().nonnegative(),
  })
  .strict();

/**
 * `version` is the file format version (migrations key off it); `revision` is the content version that every
 * operation returns and every write must match.
 */
export const ProjectDocumentSchema = z
  .object({
    format: z.literal("slate.project"),
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    commit: z.string().startsWith("cmt_"),
    id: z.string().startsWith("prj_"),
    name: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    settings: ProjectSettingsSchema,
    budget: BudgetSchema,
    chains: z.record(z.array(z.string())),
  })
  .strict();

export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;

export function projectDocumentJson(document: ProjectDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function readProjectDocument(root: string): Promise<ProjectDocument> {
  const paths = projectPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.projectFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SlateError("not_found", `no project at ${root}`, { detail: { root } });
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlateError("invalid_document", "project.json is not valid JSON", {
      detail: { file: "project.json" },
    });
  }

  const result = ProjectDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new SlateError("invalid_document", "project.json does not match the project schema", {
      detail: {
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return result.data;
}
