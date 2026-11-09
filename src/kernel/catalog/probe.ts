import type { RunResult } from "../adapters/command-runner.js";
import { type ServiceDefinition, type ServiceId, overrideFromEnv, serviceDefinitions } from "./services.js";

export type ServiceStatus = "green" | "amber" | "red";
export type ServiceSource = "env" | "vendor" | "registry" | "known" | "path" | "none";

export interface ServiceState {
  id: ServiceId;
  displayName: string;
  required: boolean;
  status: ServiceStatus;
  /** The binary that answered, or null. A host path is fine here: this never leaves the daemon. */
  binary: string | null;
  source: ServiceSource;
  version: string | null;
  detail: string;
}

export type RunProbe = (argv: string[]) => Promise<RunResult>;

export interface ProbeDeps {
  run: RunProbe;
  vendorDir: string;
  now: string;
  /** Absolute paths found by discovery (for example the Windows uninstall registry), in priority order. */
  hints?: Partial<Record<ServiceId, string[]>>;
  /** Explicit overrides from environment or config, which win over everything else. */
  overrides?: Partial<Record<ServiceId, string>>;
  env?: NodeJS.ProcessEnv;
  definitions?: ServiceDefinition[];
}

interface Candidate {
  path: string;
  source: Exclude<ServiceSource, "none">;
}

const SOURCE_LABEL: Record<Exclude<ServiceSource, "none">, string> = {
  env: "configured path",
  vendor: "vendored copy",
  registry: "installed application",
  known: "common install folder",
  path: "PATH",
};

/**
 * Candidate order is intentional: an explicit override beats a managed copy, which beats a discovered install,
 * which beats a conventional directory, and PATH comes last so an installed application is not shadowed by a stale
 * shim.
 */
function candidates(definition: ServiceDefinition, deps: ProbeDeps): Candidate[] {
  const list: Candidate[] = [];

  const override = deps.overrides?.[definition.id] ?? overrideFromEnv(definition.id, deps.env);
  if (override) list.push({ path: override, source: "env" });
  for (const path of definition.vendorPaths(deps.vendorDir)) list.push({ path, source: "vendor" });
  for (const path of deps.hints?.[definition.id] ?? []) list.push({ path, source: "registry" });
  for (const path of definition.knownPaths()) list.push({ path, source: "known" });
  list.push({ path: definition.executable, source: "path" });

  return list;
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
  const searched = new Set<string>();

  for (const candidate of candidates(definition, deps)) {
    searched.add(SOURCE_LABEL[candidate.source]);
    const result = await deps.run([candidate.path, ...definition.versionArgs]);
    if (result.failedToStart) continue;

    const matched = definition.versionPattern.exec(result.stdout + result.stderr);
    let version = matched?.[1] ?? null;
    let versionVia: string | null = null;

    if (!version && definition.versionProbe) {
      // The executing binary cannot report its version; a sibling command can. Report which one answered.
      for (const sibling of definition.versionProbe(candidate.path)) {
        const siblingResult = await deps.run([sibling, ...definition.versionArgs]);
        if (siblingResult.failedToStart) continue;
        const siblingMatch = definition.versionPattern.exec(siblingResult.stdout + siblingResult.stderr);
        if (siblingMatch?.[1]) {
          version = siblingMatch[1];
          versionVia = sibling.split(/[\\/]/u).pop() ?? sibling;
          break;
        }
      }
    }

    // A version obtained from a sibling proves the install; the primary command's exit code is then irrelevant
    // (openshot-cli rejects --version with exit 2 while its sibling reports 4.1.1).
    if (version) {
      return {
        id: definition.id,
        displayName: definition.displayName,
        required: definition.required,
        status: "green",
        binary: candidate.path,
        source: candidate.source,
        version,
        detail: `${definition.displayName} ${version} — ${SOURCE_LABEL[candidate.source]}${
          versionVia ? ` (version reported by ${versionVia})` : ""
        }`,
      };
    }

    return {
      id: definition.id,
      displayName: definition.displayName,
      required: definition.required,
      status: "amber",
      binary: candidate.path,
      source: candidate.source,
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
    detail: `not found (searched ${[...searched].join(", ")})`,
  };
}
