import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { newId } from "../../domain/ids.js";
import { SlateError } from "../../domain/result.js";
import { writeFileAtomic } from "../../kernel/workspace/atomic.js";

export const ProjectEntrySchema = z
  .object({
    id: z.string().startsWith("prj_"),
    name: z.string().min(1),
    /** Absolute host path. Server-side only; never serialised into an API response. */
    path: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

const ProjectsFileSchema = z
  .object({
    format: z.literal("slate.projects"),
    version: z.literal(1),
    projects: z.array(ProjectEntrySchema),
  })
  .strict();

export function projectsFile(home: string): string {
  return join(home, "projects.json");
}

export async function readProjects(home: string): Promise<ProjectEntry[]> {
  let raw: string;
  try {
    raw = await readFile(projectsFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = ProjectsFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new SlateError("invalid_document", "projects.json is malformed", {
      detail: { file: "projects.json" },
    });
  }
  return parsed.data.projects;
}

export async function writeProjects(home: string, projects: ProjectEntry[]): Promise<void> {
  await writeFileAtomic(
    projectsFile(home),
    `${JSON.stringify({ format: "slate.projects", version: 1, projects }, null, 2)}\n`,
  );
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug === "" ? "project" : slug;
}

/** Projects created from the UI live under the Slate home; a project opened from disk is registered by path. */
export function newProjectPath(home: string, name: string): string {
  const id = newId("prj").slice(4, 12);
  return join(home, "projects", `${slugify(name)}-${id}`);
}

export async function registerProject(
  home: string,
  input: { id: string; name: string; path: string; createdAt: string },
): Promise<ProjectEntry> {
  const projects = await readProjects(home);
  if (projects.some((project) => project.id === input.id))
    return projects.find((project) => project.id === input.id) as ProjectEntry;
  const entry: ProjectEntry = {
    id: input.id,
    name: input.name,
    path: input.path,
    createdAt: input.createdAt,
  };
  await writeProjects(home, [...projects, entry]);
  return entry;
}
