import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashValue } from "../../domain/canonical.js";
import type { Clock } from "../../domain/clock.js";
import { type CommitId, newId } from "../../domain/ids.js";
import { SlateError } from "../../domain/result.js";
import { writeFileAtomic } from "./atomic.js";
import { type CommitRecord, appendCommit } from "./commits.js";
import { type ProjectPaths, projectPaths } from "./paths.js";
import {
  type ProductionDocument,
  ProductionDocumentSchema,
  emptyProductionDocument,
  productionDocumentJson,
  readProductionDocument,
} from "./production-doc.js";
import {
  type ProjectDocument,
  ProjectDocumentSchema,
  projectDocumentJson,
  readProjectDocument,
} from "./project-doc.js";

export interface CommitDocumentsRequest {
  root: string;
  actor: string;
  intent: string;
  /** Node ids this change touches; the basis for conflict detection between concurrent writers. */
  touched: string[];
  clock: Clock;
  /** Revision the caller read. A mismatch is a conflict, never an overwrite. */
  expectedRevision?: number;
  /** Labelled strings worth keeping about how this change was made: a prompt, a response, a model. */
  detail?: Record<string, string>;
  mutate: (documents: { project: ProjectDocument; production: ProductionDocument }) => void;
}

export interface CommitDocumentsResult {
  project: ProjectDocument;
  production: ProductionDocument;
  commit: CommitRecord;
  paths: ProjectPaths;
}

function invalid(
  label: string,
  error: { issues: Array<{ path: (string | number)[]; message: string }> },
): SlateError {
  return new SlateError("invalid_document", `the change produced an invalid ${label}`, {
    detail: {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
  });
}

/**
 * One revision clock for both documents. Snapshot, mutate, bump the shared revision, write the documents, then
 * append the commit — so a crash leaves a state the log does not describe, which is recoverable, rather than a log
 * claiming a change that never landed.
 */
export async function commitDocuments(request: CommitDocumentsRequest): Promise<CommitDocumentsResult> {
  const paths = projectPaths(request.root);
  const currentProject = await readProjectDocument(request.root);
  const currentProduction =
    (await readProductionDocument(request.root)) ??
    emptyProductionDocument(currentProject.revision, currentProject.commit);

  if (request.expectedRevision !== undefined && request.expectedRevision !== currentProject.revision) {
    throw new SlateError("conflict", "the project changed since it was read", {
      detail: { expectedRevision: request.expectedRevision, actualRevision: currentProject.revision },
    });
  }

  const snapshotDir = join(paths.historyDir, currentProject.commit);
  await mkdir(snapshotDir, { recursive: true });
  await copyFile(paths.projectFile, join(snapshotDir, "project.json"));
  if (await readProductionDocument(request.root)) {
    await copyFile(paths.productionFile, join(snapshotDir, "production.json"));
  }

  const draft = {
    project: structuredClone(currentProject),
    production: structuredClone(currentProduction),
  };
  request.mutate(draft);

  const revision = currentProject.revision + 1;
  const commit = newId("cmt");
  draft.project.revision = revision;
  draft.project.updatedAt = request.clock.now();
  draft.project.commit = commit;
  draft.production.revision = revision;
  draft.production.commit = commit;

  const project = ProjectDocumentSchema.safeParse(draft.project);
  if (!project.success) throw invalid("project document", project.error);
  const production = ProductionDocumentSchema.safeParse(draft.production);
  if (!production.success) throw invalid("production document", production.error);

  await writeFileAtomic(paths.productionFile, productionDocumentJson(production.data));
  await writeFileAtomic(paths.projectFile, projectDocumentJson(project.data));

  const record: CommitRecord = {
    id: commit as CommitId,
    parent: currentProject.commit as CommitId,
    at: project.data.updatedAt,
    actor: request.actor,
    intent: request.intent,
    revision,
    touched: request.touched,
    ...(request.detail ? { detail: request.detail } : {}),
    projectHash: hashValue(project.data),
    productionHash: hashValue(production.data),
  };
  await appendCommit(paths, record);

  return { project: project.data, production: production.data, commit: record, paths };
}
