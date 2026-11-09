import { capabilitiesGet } from "./capabilities.js";
import { cutBuild, cutGet, cutRender } from "./cut.js";
import { frameAttach } from "./frame.js";
import { graphStale, sessionBrief } from "./graph.js";
import { projectHistory } from "./history.js";
import { projectCreate, projectRename } from "./project.js";
import { OpRegistry } from "./registry.js";
import { sceneCreate, sceneList, sceneUpdate } from "./scene.js";
import { serviceClearPath, serviceSetPath } from "./service.js";
import { shotCreate, shotGet, shotRebase, shotUpdate } from "./shot.js";
import { storyGet, storySet } from "./story.js";
import { planVocabulary } from "./vocabulary.js";

/** The one registry. Every surface resolves operations through this list. */
export function createRegistry(): OpRegistry {
  return new OpRegistry().register(
    projectCreate,
    projectRename,
    projectHistory,
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
    graphStale,
    sessionBrief,
    planVocabulary,
  );
}

export { OpRegistry } from "./registry.js";
export type { OpContext, OpDefinition, OpOutcome, OpPolicy } from "./types.js";
