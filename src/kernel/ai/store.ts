import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../workspace/atomic.js";
import { canonicalCapability } from "./capabilities.js";
import {
  type AiConfig,
  AiConfigSchema,
  type BindingSet,
  type Endpoint,
  type Provider,
} from "./declaration.js";

export function aiPaths(home: string): { configFile: string; keysFile: string; dir: string } {
  const dir = join(home, "ai");
  return { dir, configFile: join(dir, "config.json"), keysFile: join(dir, "keys.json") };
}

function emptyConfig(): AiConfig {
  return {
    format: "slate.ai",
    version: 1,
    providers: [],
    endpoints: [],
    bindingSets: [],
    defaultBindingSetId: null,
  };
}

/** Older configs stored one flat binding map; it becomes a single "Default" set the first time it is read. */
function migrate(parsed: AiConfig): AiConfig {
  const { bindings, ...rest } = parsed;

  // A capability that has been renamed since this file was written is read as its current name. Doing it here, rather
  // than in the schema, is what keeps an old config from failing to parse and coming back as an empty catalogue.
  const endpoints = parsed.endpoints.map((endpoint) => ({
    ...endpoint,
    capability: canonicalCapability(endpoint.capability) ?? endpoint.capability,
  }));
  const bindingSets = (parsed.bindingSets ?? []).map((set) => ({
    ...set,
    bindings: Object.fromEntries(
      Object.entries(set.bindings).map(([capability, ids]) => [
        canonicalCapability(capability) ?? capability,
        ids,
      ]),
    ),
  }));
  if (bindingSets.length > 0) {
    return {
      ...rest,
      endpoints,
      bindingSets,
      defaultBindingSetId: parsed.defaultBindingSetId ?? bindingSets[0]?.id ?? null,
    };
  }
  if (!bindings || Object.keys(bindings ?? {}).length === 0) {
    return { ...rest, endpoints, bindingSets: [], defaultBindingSetId: parsed.defaultBindingSetId ?? null };
  }
  const migrated: BindingSet = {
    id: "aib_default",
    name: "Default",
    description: "Migrated from the original flat bindings",
    bindings,
    createdAt: new Date(0).toISOString(),
  };
  return { ...rest, endpoints, bindingSets: [migrated], defaultBindingSetId: migrated.id };
}

export async function readAiConfig(home: string): Promise<AiConfig> {
  const raw = await readFile(aiPaths(home).configFile, "utf8").catch(() => null);
  if (raw === null) return emptyConfig();
  const parsed = AiConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success ? migrate(parsed.data) : emptyConfig();
}

export async function writeAiConfig(home: string, config: AiConfig): Promise<void> {
  const paths = aiPaths(home);
  await mkdir(paths.dir, { recursive: true });
  await writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

/** Keys live in their own file, readable only by the account running the daemon. They never enter a document or a log. */
export async function readKeys(home: string): Promise<Record<string, string>> {
  const raw = await readFile(aiPaths(home).keysFile, "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function writeKeys(home: string, keys: Record<string, string>): Promise<void> {
  const paths = aiPaths(home);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.keysFile, `${JSON.stringify(keys, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(paths.keysFile, 0o600).catch(() => undefined);
}

export function providerById(config: AiConfig, id: string): Provider | undefined {
  return config.providers.find((provider) => provider.id === id);
}

export function endpointById(config: AiConfig, id: string): Endpoint | undefined {
  return config.endpoints.find((endpoint) => endpoint.id === id);
}

export function bindingSetFor(config: AiConfig, setId: string | null): BindingSet | null {
  return config.bindingSets.find((set) => set.id === setId) ?? null;
}

/** Which rung of the resolution chain answered. A degraded rung is reported, never hidden. */
export type BindingRung = "project" | "host-default" | "any";

export interface BindingResolution {
  endpoint: Endpoint;
  /** The set that answered; null when no set bound the capability and the last resort answered. */
  bindingSetId: string | null;
  bindingSetName: string | null;
  via: BindingRung;
}

/**
 * The endpoint that serves a capability for a project: the first live endpoint of the set the project chose, then the
 * host default, then any endpoint of that capability. Falling back is deliberate — a set that loses an endpoint should
 * degrade a film, not break one mid-production — but the winning rung is returned so the caller can report it.
 */
export function resolveBinding(
  config: AiConfig,
  capability: string,
  projectSetId: string | null = null,
): BindingResolution | null {
  const rungs: Array<[BindingRung, BindingSet | null]> = [];
  const chosen = bindingSetFor(config, projectSetId);
  if (chosen) rungs.push(["project", chosen]);
  const hostDefault = bindingSetFor(config, config.defaultBindingSetId);
  if (hostDefault && hostDefault.id !== chosen?.id) rungs.push(["host-default", hostDefault]);

  for (const [via, set] of rungs) {
    for (const id of set?.bindings[capability] ?? []) {
      const endpoint = endpointById(config, id);
      if (endpoint) {
        return { endpoint, bindingSetId: set?.id ?? null, bindingSetName: set?.name ?? null, via };
      }
    }
  }

  const any = config.endpoints.find((endpoint) => endpoint.capability === capability);
  return any ? { endpoint: any, bindingSetId: null, bindingSetName: null, via: "any" } : null;
}
