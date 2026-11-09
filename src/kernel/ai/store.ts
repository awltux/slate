import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../workspace/atomic.js";
import { type AiConfig, AiConfigSchema, type Endpoint, type Provider } from "./declaration.js";

export function aiPaths(home: string): { configFile: string; keysFile: string; dir: string } {
  const dir = join(home, "ai");
  return { dir, configFile: join(dir, "config.json"), keysFile: join(dir, "keys.json") };
}

export async function readAiConfig(home: string): Promise<AiConfig> {
  const raw = await readFile(aiPaths(home).configFile, "utf8").catch(() => null);
  if (raw === null) {
    return { format: "slate.ai", version: 1, providers: [], endpoints: [], bindings: {} };
  }
  const parsed = AiConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success
    ? parsed.data
    : { format: "slate.ai", version: 1, providers: [], endpoints: [], bindings: {} };
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

/** The endpoint that will serve a capability: first bound one that exists, or undefined. */
export function resolveEndpoint(config: AiConfig, capability: string): Endpoint | undefined {
  for (const id of config.bindings[capability] ?? []) {
    const endpoint = endpointById(config, id);
    if (endpoint) return endpoint;
  }
  return config.endpoints.find((endpoint) => endpoint.capability === capability);
}
