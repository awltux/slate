import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SlateError } from "../../domain/result.js";
import { projectPaths } from "./paths.js";

/**
 * The shape of the film, fixed when the project is created because everything downstream depends on it: the stills, the
 * cut render and the delivered master all take their size and rate from here rather than choosing per call.
 */
export const ProjectSettingsSchema = z
  .object({
    runtimeSeconds: z.number().positive(),
    aspectRatio: z.string().regex(/^\d+:\d+$/u, "aspect ratio must look like 16:9"),
    /** Frames per second for the cut render and the master. */
    frameRate: z.number().int().min(1).max(120).default(24),
    /** The short edge in pixels — what "1080p" means in either orientation. */
    resolutionPixels: z.number().int().min(240).max(4320).default(1080),
    /** The style sheet every entity uses unless it names one: a project default, so a look is set once. */
    defaultStyleId: z.string().startsWith("ent_").nullable().default(null),
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
    /** Which binding set this project uses; null means the host default. */
    aiBindingSetId: z.string().startsWith("aib_").nullable().default(null),
    /**
     * This film's own copy of each library type's instructions. Empty means the global library's, and then the built-in
     * default - so a project only ever stores a deliberate difference.
     */
    systemPrompts: z.record(z.string(), z.string()).default({}),
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
