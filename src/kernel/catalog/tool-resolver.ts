import { readConfig } from "../config.js";
import { type RunProbe, type ServiceState, probeServices } from "./probe.js";
import { discoverInstalls } from "./registry-scan.js";
import type { ServiceId } from "./services.js";

export type ToolResolver = (id: ServiceId) => Promise<ServiceState>;

/**
 * Resolve a tool to the binary that will actually run it. Nothing is cached: an operator who fixes a path expects the
 * next render to use it, and probing one service costs less than a video frame. Discovery is still consulted, so an
 * install outside PATH is found without configuration.
 */
export function createToolResolver(deps: {
  run: RunProbe;
  vendorDir: string;
  now: () => string;
  home?: string;
}): ToolResolver {
  return async (id: ServiceId) => {
    const config = deps.home ? await readConfig(deps.home) : { paths: {} };
    const hints = await discoverInstalls(deps.run);
    const states = await probeServices({
      run: deps.run,
      vendorDir: deps.vendorDir,
      now: deps.now(),
      hints,
      overrides: config.paths,
    });
    return (
      states.find((state) => state.id === id) ?? {
        id,
        displayName: id,
        required: false,
        status: "red" as const,
        binary: null,
        source: "none" as const,
        version: null,
        detail: "not probed",
      }
    );
  };
}
