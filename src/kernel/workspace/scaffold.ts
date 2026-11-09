import { mkdir, stat } from "node:fs/promises";
import { hashValue } from "../../domain/canonical.js";
import type { Clock } from "../../domain/clock.js";
import { type CommitId, newId } from "../../domain/ids.js";
import { SlateError } from "../../domain/result.js";
import { writeFileAtomic } from "./atomic.js";
import { type CommitRecord, appendCommit } from "./commits.js";
import { type ProjectPaths, projectPaths } from "./paths.js";
import { type ProjectDocument, projectDocumentJson } from "./project-doc.js";

export interface InitProjectRequest {
  root: string;
  name: string;
  runtimeSeconds: number;
  aspectRatio: string;
  budgetUsd: number;
  clock: Clock;
  actor?: string;
}

export interface InitProjectResult {
  project: ProjectDocument;
  commit: CommitRecord;
  paths: ProjectPaths;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Create a project folder. Refuses to touch an existing project: no partial or duplicated state. */
export async function initProject(request: InitProjectRequest): Promise<InitProjectResult> {
  const paths = projectPaths(request.root);

  if (await exists(paths.projectFile)) {
    throw new SlateError("conflict", "a project already exists here", { detail: { root: paths.root } });
  }

  for (const directory of [
    paths.storyDir,
    paths.revisionsDir,
    paths.cutDir,
    paths.mediaSourceDir,
    paths.mediaBoardsDir,
    paths.mediaGeneratedDir,
    paths.mediaBlockoutsDir,
    paths.mediaAudioDir,
    paths.mediaLibraryDir,
    paths.workDir,
    paths.exportsDir,
    paths.slateDir,
    paths.historyDir,
    paths.jobsDir,
    paths.lockDir,
    paths.cacheDir,
  ]) {
    await mkdir(directory, { recursive: true });
  }

  const at = request.clock.now();
  const project: ProjectDocument = {
    format: "slate.project",
    version: 1,
    revision: 0,
    commit: newId("cmt"),
    id: newId("prj"),
    name: request.name,
    createdAt: at,
    updatedAt: at,
    settings: { runtimeSeconds: request.runtimeSeconds, aspectRatio: request.aspectRatio },
    budget: { currency: "USD", ceilingUsd: request.budgetUsd },
    chains: {},
  };

  await writeFileAtomic(paths.projectFile, projectDocumentJson(project));

  const commit: CommitRecord = {
    id: project.commit as CommitId,
    parent: null,
    at,
    actor: request.actor ?? "system",
    intent: "create project",
    revision: 0,
    touched: ["project"],
    projectHash: hashValue(project),
    productionHash: null,
  };
  await appendCommit(paths, commit);

  return { project, commit, paths };
}
