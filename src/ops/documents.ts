import {
  type ProductionDocument,
  emptyProductionDocument,
  readProductionDocument,
} from "../kernel/workspace/production-doc.js";
import { type ProjectDocument, readProjectDocument } from "../kernel/workspace/project-doc.js";
import type { OpContext } from "./types.js";

/** Both documents, with an empty production document when the project has not been planned yet. */
export async function loadDocuments(
  context: OpContext,
): Promise<{ project: ProjectDocument; production: ProductionDocument }> {
  const project = await readProjectDocument(context.root);
  const production =
    (await readProductionDocument(context.root)) ?? emptyProductionDocument(project.revision, project.commit);
  return { project, production };
}
