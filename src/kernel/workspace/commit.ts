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
  type ProjectDocument,
  ProjectDocumentSchema,
  projectDocumentJson,
  readProjectDocument,
} from "./project-doc.js";

export interface CommitRequest {
  root: string;
  actor: string;
  intent: string;
  /** Node ids this change touches; the basis for conflict detection between concurrent writers. */
  touched: string[];
  clock: Clock;
  /** Revision the caller read. A mismatch is a conflict, never an overwrite. */
  expectedRevision?: number;
  mutate: (document: ProjectDocument) => void;
}

export interface CommitResult {
  project: ProjectDocument;
  commit: CommitRecord;
  paths: ProjectPaths;
}

/**
 * Apply one change to `project.json` and record it: snapshot, mutate, validate, atomic write, append commit.
 * The commit log is written last, so a crash leaves a document that the log does not describe — recoverable.
 */
export async function commitProject(request: CommitRequest): Promise<CommitResult> {
  const paths = projectPaths(request.root);
  const current = await readProjectDocument(request.root);

  if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
    throw new SlateError("conflict", "project changed since it was read", {
      detail: { expectedRevision: request.expectedRevision, actualRevision: current.revision },
    });
  }

  const snapshotDir = join(paths.historyDir, current.commit);
  await mkdir(snapshotDir, { recursive: true });
  await copyFile(paths.projectFile, join(snapshotDir, "project.json"));

  const draft = structuredClone(current);
  request.mutate(draft);
  draft.revision = current.revision + 1;
  draft.updatedAt = request.clock.now();
  draft.commit = newId("cmt");

  const parsed = ProjectDocumentSchema.safeParse(draft);
  if (!parsed.success) {
    throw new SlateError("invalid_document", "the change produced an invalid project document", {
      detail: {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  const next = parsed.data;
  await writeFileAtomic(paths.projectFile, projectDocumentJson(next));

  const record: CommitRecord = {
    id: next.commit as CommitId,
    parent: current.commit as CommitId,
    at: next.updatedAt,
    actor: request.actor,
    intent: request.intent,
    revision: next.revision,
    touched: request.touched,
    projectHash: hashValue(next),
    productionHash: null,
  };
  await appendCommit(paths, record);

  return { project: next, commit: record, paths };
}
