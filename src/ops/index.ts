import { agentAccess } from "./agent.js";
import {
  aiBindingSetRemove,
  aiBindingSetSave,
  aiBindingSetUse,
  aiBindingSets,
  aiCatalog,
  aiEndpointDraft,
  aiEndpointSave,
  aiPreview,
  aiProviderSave,
  aiReferenceTest,
  aiRemove,
} from "./ai.js";
import { projectExport, projectImport } from "./archive.js";
import { capabilitiesGet } from "./capabilities.js";
import { cutBuild, cutGet, cutRender } from "./cut.js";
import { deliverExport, deliverQc } from "./deliver.js";
import { dialogPickFolder } from "./dialog.js";
import { entityGenerate } from "./entity-generate.js";
import {
  entityAngles,
  entityCreate,
  entityDelete,
  entityList,
  entityUpdate,
  sheetEdit,
  sheetPublish,
  shotSetEntities,
  variantCreate,
  variantDelete,
  variantUpdate,
} from "./entity.js";
import { frameGenerate } from "./frame-generate.js";
import { frameAttach } from "./frame.js";
import { graphStale, sessionBrief } from "./graph.js";
import { historyRevert, projectHistory } from "./history.js";
import { libraryImport, libraryList, libraryPull, libraryPush, libraryStyles } from "./library.js";
import { blockoutAttach, previzGet, setAttach } from "./previz.js";
import { projectBudget, projectCreate, projectDelete, projectUpdate } from "./project.js";
import { promptExpand } from "./prompt.js";
import { OpRegistry } from "./registry.js";
import { noteAdd, noteList, noteResolve, reviewLink, reviewLinks, reviewRevoke } from "./review.js";
import { sceneCreate, sceneList, sceneSetEntities, sceneUpdate } from "./scene.js";
import { serviceClearPath, serviceSetPath } from "./service.js";
import { shotCreate, shotGet, shotRebase, shotUpdate } from "./shot.js";
import { estimateCreate, spendApprove, spendSummary } from "./spend.js";
import { storyGet, storySet } from "./story.js";
import { jobGet, takeGenerate, takeList, takeSelect } from "./take.js";
import { planVocabulary } from "./vocabulary.js";

/** The one registry. Every surface resolves operations through this list. */
export function createRegistry(): OpRegistry {
  return new OpRegistry().register(
    projectCreate,
    projectBudget,
    projectDelete,
    projectUpdate,
    projectExport,
    projectImport,
    projectHistory,
    historyRevert,
    capabilitiesGet,
    storyGet,
    storySet,
    sceneCreate,
    sceneSetEntities,
    sceneUpdate,
    sceneList,
    shotCreate,
    shotUpdate,
    shotRebase,
    shotGet,
    frameAttach,
    cutGet,
    cutBuild,
    cutRender,
    serviceSetPath,
    serviceClearPath,
    entityCreate,
    entityUpdate,
    entityDelete,
    entityAngles,
    aiCatalog,
    aiProviderSave,
    aiEndpointDraft,
    aiEndpointSave,
    aiBindingSetSave,
    aiBindingSets,
    aiBindingSetUse,
    agentAccess,
    dialogPickFolder,
    aiBindingSetRemove,
    aiRemove,
    aiPreview,
    aiReferenceTest,
    reviewLink,
    reviewLinks,
    reviewRevoke,
    noteAdd,
    noteList,
    noteResolve,
    frameGenerate,
    promptExpand,
    libraryPush,
    libraryPull,
    libraryImport,
    libraryList,
    libraryStyles,
    deliverExport,
    deliverQc,
    entityGenerate,
    sheetEdit,
    sheetPublish,
    entityList,
    variantCreate,
    variantUpdate,
    variantDelete,
    shotSetEntities,
    setAttach,
    blockoutAttach,
    previzGet,
    estimateCreate,
    spendApprove,
    spendSummary,
    takeGenerate,
    takeList,
    takeSelect,
    jobGet,
    graphStale,
    sessionBrief,
    planVocabulary,
  );
}

export { OpRegistry } from "./registry.js";
export type { OpContext, OpDefinition, OpOutcome, OpPolicy } from "./types.js";
