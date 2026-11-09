import { capabilitiesGet } from "./capabilities.js";
import { cutBuild, cutGet, cutRender } from "./cut.js";
import { entityGenerate } from "./entity-generate.js";
import {
  entityAngles,
  entityCreate,
  entityDelete,
  entityList,
  entityUpdate,
  sheetSelect,
  shotSetEntities,
  variantCreate,
  variantDelete,
  variantUpdate,
} from "./entity.js";
import { frameAttach } from "./frame.js";
import { graphStale, sessionBrief } from "./graph.js";
import { historyRevert, projectHistory } from "./history.js";
import { blockoutAttach, previzGet, setAttach } from "./previz.js";
import { projectCreate, projectRename } from "./project.js";
import { OpRegistry } from "./registry.js";
import { sceneCreate, sceneList, sceneUpdate } from "./scene.js";
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
    projectRename,
    projectHistory,
    historyRevert,
    capabilitiesGet,
    storyGet,
    storySet,
    sceneCreate,
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
    entityGenerate,
    sheetSelect,
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
