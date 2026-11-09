import { capabilitiesGet } from "./capabilities.js";
import { projectHistory } from "./history.js";
import { projectCreate } from "./project.js";
import { OpRegistry } from "./registry.js";

/** The one registry. Every surface resolves operations through this list. */
export function createRegistry(): OpRegistry {
  return new OpRegistry().register(projectCreate, projectHistory, capabilitiesGet);
}

export { OpRegistry } from "./registry.js";
export type { OpContext, OpDefinition, OpOutcome, OpPolicy } from "./types.js";
