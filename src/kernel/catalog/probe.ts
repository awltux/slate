import { relative } from "node:path";
import type { RunResult } from "../adapters/command-runner.js";
import { type ServiceDefinition, type ServiceId, serviceDefinitions } from "./services.js";

export type ServiceStatus = "green" | "amber" | "red";

export interface ServiceState {
  id: ServiceId;
  displayName: string;
  required: boolean;
  status: ServiceStatus;
  /** The binary that answered, or null. A host path is fine here: this never leaves the daemon. */
  binary: string | null;
  source: "path" | "vendor" | "none";
  version: string | null;
  detail: string;
}

export type RunProbe = (argv: string[]) => Promise<RunResult>;

export interface ProbeDeps {
  run: RunProbe;
  vendorDir: string;
  now: string;
  definitions?: ServiceDefinition[];
  timeoutMs?: number;
}

/**
 * Probe each service by running its own version command. A binary that starts but does not report a version is
 * `amber` (installed, unverified) rather than green: the GUIDE requires the agent to report which path it will
 * take, and an unverified tool is not a path yet.
 */
export async function probeServices(deps: ProbeDeps): Promise<ServiceState[]> {
  const definitions = deps.definitions ?? serviceDefinitions();
  const states: ServiceState[] = [];

  for (const definition of definitions) {
    states.push(await probeOne(definition, deps));
  }
  return states;
}

async function probeOne(definition: ServiceDefinition, deps: ProbeDeps): Promise<ServiceState> {
  const looked: string[] = [];

  for (const binary of definition.binaries(deps.vendorDir)) {
    const vendored = binary.startsWith(deps.vendorDir);
    looked.push(
      vendored ? "vendor" : binary.includes("/") || binary.includes("\\") ? "known locations" : "PATH",
    );

    const result = await deps.run([binary, ...definition.versionArgs]);
    if (result.failedToStart) continue;

    const source: "path" | "vendor" = vendored ? "vendor" : "path";
    const matched = definition.versionPattern.exec(result.stdout + result.stderr);
    const version = matched?.[1] ?? null;

    if (result.code === 0 && version) {
      return {
        id: definition.id,
        displayName: definition.displayName,
        required: definition.required,
        status: "green",
        binary,
        source,
        version,
        detail: `${definition.displayName} ${version}`,
      };
    }

    return {
      id: definition.id,
      displayName: definition.displayName,
      required: definition.required,
      status: "amber",
      binary,
      source,
      version,
      detail: version
        ? `${definition.displayName} ${version} answered with exit code ${result.code ?? "null"}`
        : `${definition.displayName} ran but did not report a version`,
    };
  }

  return {
    id: definition.id,
    displayName: definition.displayName,
    required: definition.required,
    status: "red",
    binary: null,
    source: "none",
    version: null,
    // Never the host paths: this detail is shown to remote clients.
    detail: `not found (searched ${[...new Set(looked)].join(", ")})`,
  };
}
